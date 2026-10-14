import { useSyncExternalStore } from 'react';
import {
  AudioManifestSchema,
  AudioMarkSchema,
  clipKey,
  playableClip,
  type AudioKind,
  type AudioManifest,
  type AudioMark,
} from '@anan/core';
import { z } from 'zod';
import { authHeaders, getActiveProfileForApi, handleUnauthorized, proxyBase } from './api.js';

// Phase 10: the web side of verified audio. The manifest (static, from the
// build) says what clips exist; the household's marks (from the proxy) say which
// ones people flagged or approved. `playableClip` in core is the only gate, and
// a clip with no manifest entry, or one flagged/suspect, simply has no button.

/**
 * Owner's decision (no Mandarin-speaking reviewer yet): clips the automatic
 * check marked `suspect` still play. They stay marked suspect in the manifest
 * and on the review page. Set to false once the review page has been worked
 * through; `flagged` clips never play either way.
 */
export const ALLOW_SUSPECT_AUDIO = true;

const MARKS_KEY = 'anan.audioMarks';
const PENDING_KEY = 'anan.audioPending';
const SLOW_KEY = 'anan.audioSlow';

/** Phase 40 D.1: whether the server can make tutoring clips (its speech key is set). */
export type TutorSpeechState = 'unknown' | 'configured' | 'not_configured';

interface State {
  /** The static manifest merged with the active profile's tutoring clips (static wins on a clash). */
  manifest: AudioManifest | null;
  marks: Record<string, AudioMark>;
  /** exact sentence text -> sentence id, so any screen can ask "is there a clip for this line?" */
  byText: Map<string, string>;
  /** Phase 40 D.1: the build's manifest alone. */
  staticManifest?: AudioManifest | null;
  /** Phase 40 D.1: the profile's tutoring clips (files already absolute proxy URLs). */
  tutor?: { profileId: string; manifest: AudioManifest } | null;
  tutorSpeech?: TutorSpeechState;
}

let state: State = {
  manifest: null,
  marks: readStored(MARKS_KEY, z.record(AudioMarkSchema)) ?? {},
  byText: new Map(),
  staticManifest: null,
  tutor: null,
  tutorSpeech: 'unknown',
};
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

function readStored<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? schema.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: marks just won't survive offline */
  }
};

export const audioBase = (): string => `${import.meta.env.BASE_URL}audio/`;

/** A clip's URL: static clips live under the audio root; tutoring clips are absolute proxy URLs. */
export const clipUrl = (fileOrUrl: string): string =>
  /^(https?:)?\/\//.test(fileOrUrl) || fileOrUrl.startsWith('/') ? fileOrUrl : `${audioBase()}${fileOrUrl}`;

/** Tutoring clips are behind the household code, which an <audio src> can't send: they are
 * fetched with the header and played from a blob (as every clip already is). */
const isProxyUrl = (url: string): boolean => url.startsWith(`${proxyBase()}/`);

/** Fetch one clip whole (with the household code when it is a proxy URL). */
export function fetchClip(url: string): Promise<Response> {
  return isProxyUrl(url) ? fetch(url, { headers: authHeaders() }) : fetch(url);
}

// ---- Phase 40 D.1: the manifest = static ∪ the profile's tutoring clips ----------------------

/** The two manifests as one. A static clip wins over a tutoring clip with the same key. */
export function mergeManifests(stat: AudioManifest | null, tutor: AudioManifest | null): AudioManifest | null {
  if (!tutor) return stat;
  if (!stat) return tutor;
  return {
    meta: stat.meta,
    words: { ...tutor.words, ...stat.words },
    sentences: { ...tutor.sentences, ...stat.sentences },
  };
}

const sentencesByText = (m: AudioManifest | null): Map<string, string> => {
  const byText = new Map<string, string>();
  for (const [id, e] of Object.entries(m?.sentences ?? {})) byText.set(e.text, id);
  return byText;
};

function setManifests(stat: AudioManifest | null, tutor: State['tutor']): void {
  const manifest = mergeManifests(stat, tutor?.manifest ?? null);
  // the static sentence wins a text clash too: it is written last
  const byText = sentencesByText(tutor?.manifest ?? null);
  for (const [text, id] of sentencesByText(stat)) byText.set(text, id);
  set({ staticManifest: stat, tutor, manifest, byText });
}

/** A tutoring manifest from the proxy, its relative files turned into the proxy URLs that serve them. */
export function tutorManifestForWeb(profileId: string, m: AudioManifest): AudioManifest {
  const abs = (section: AudioManifest['words']) =>
    Object.fromEntries(
      Object.entries(section).map(([id, e]) => [
        id,
        { ...e, file: clipUrl(e.file) === e.file ? e.file : `${proxyBase()}/v1/tutor-audio/file/${profileId}/${e.file}` },
      ]),
    );
  return { meta: m.meta, words: abs(m.words), sentences: abs(m.sentences) };
}

const tutorStoreKey = (profileId: string) => `anan.tutorAudio.${profileId}`;

/** Replace (or, with `merge`, add to) the active profile's tutoring clips. `manifest` is as the proxy
 * sends it (relative files). */
export function setTutorManifest(
  profileId: string,
  manifest: AudioManifest,
  opts: { merge?: boolean; speech?: TutorSpeechState } = {},
): void {
  const web = tutorManifestForWeb(profileId, manifest);
  const prev = state.tutor?.profileId === profileId ? state.tutor.manifest : null;
  const next: AudioManifest =
    opts.merge && prev
      ? { meta: web.meta, words: { ...prev.words, ...web.words }, sentences: { ...prev.sentences, ...web.sentences } }
      : web;
  store(tutorStoreKey(profileId), next);
  if (opts.speech) set({ tutorSpeech: opts.speech });
  setManifests(state.staticManifest ?? null, { profileId, manifest: next });
}

export const setTutorSpeechState = (tutorSpeech: TutorSpeechState): void => set({ tutorSpeech });

const TutorManifestResponseSchema = z.object({ configured: z.boolean(), manifest: AudioManifestSchema });
let tutorLoadedFor: string | null = null;

/**
 * Phase 40 D.1: merge the profile's tutoring clips into the audio state, so `manifest`,
 * `findClip`, speaker buttons and `useListeningClips` work for tutoring word ids (key = word id)
 * and class sentences (key = sentence id, and by text). Another profile's clips are dropped.
 */
export async function loadTutorAudio(profileId: string, fetchFn: typeof fetch = fetch): Promise<void> {
  tutorLoadedFor = profileId;
  if (state.tutor && state.tutor.profileId !== profileId) setManifests(state.staticManifest ?? null, null);
  // what this browser saw last time, until the proxy answers (offline too)
  const cached = readStored(tutorStoreKey(profileId), AudioManifestSchema);
  if (cached && state.tutor?.profileId !== profileId) setManifests(state.staticManifest ?? null, { profileId, manifest: cached });
  try {
    const res = await fetchFn(`${proxyBase()}/v1/tutor-audio/manifest?profileId=${encodeURIComponent(profileId)}`, {
      headers: authHeaders(),
    });
    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) return;
    const { configured, manifest } = TutorManifestResponseSchema.parse(await res.json());
    if (tutorLoadedFor !== profileId) return; // the profile changed meanwhile
    setTutorManifest(profileId, manifest, { speech: configured ? 'configured' : 'not_configured' });
  } catch {
    /* offline or an old proxy: keep what we have */
  }
}

let loading: Promise<void> | null = null;

/** Load the manifest and the household's marks (once; call `refreshAudio` to redo). */
export function loadAudio(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${audioBase()}manifest.json`);
      if (res.ok) setManifests(AudioManifestSchema.parse(await res.json()), state.tutor ?? null);
    } catch {
      /* no audio built, or offline with nothing cached: no buttons */
    }
    const profile = getActiveProfileForApi();
    await Promise.all([refreshMarks(), profile && profile !== tutorLoadedFor ? loadTutorAudio(profile) : Promise.resolve()]);
  })();
  return loading;
}

export const refreshAudio = (): Promise<void> => {
  loading = null;
  return loadAudio();
};

async function refreshMarks(): Promise<void> {
  try {
    await flushPending();
    const res = await fetch(`${proxyBase()}/v1/audio/marks`, { headers: authHeaders() });
    if (res.status === 401) return handleUnauthorized();
    if (!res.ok) return;
    const { marks } = z.object({ marks: z.record(AudioMarkSchema) }).parse(await res.json());
    // a flag made offline and not yet delivered still counts
    const pending = readStored(PENDING_KEY, z.array(z.object({ key: z.string(), mark: AudioMarkSchema }))) ?? [];
    for (const p of pending) marks[p.key] = p.mark;
    store(MARKS_KEY, marks);
    set({ marks });
  } catch {
    /* offline: keep the last marks we saw */
  }
}

const PendingSchema = z.array(z.object({ key: z.string(), mark: AudioMarkSchema, profileId: z.string() }));

async function postMark(key: string, mark: AudioMark, profileId: string): Promise<boolean> {
  try {
    const [kind, ...rest] = key.split(':');
    const res = await fetch(`${proxyBase()}/v1/audio/mark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ kind, id: rest.join(':'), hash: mark.hash, status: mark.status, text: mark.text, profileId }),
    });
    if (res.status === 401) handleUnauthorized();
    return res.ok;
  } catch {
    return false;
  }
}

async function flushPending(): Promise<void> {
  const pending = readStored(PENDING_KEY, PendingSchema) ?? [];
  const left: typeof pending = [];
  for (const p of pending) if (!(await postMark(p.key, p.mark, p.profileId))) left.push(p);
  store(PENDING_KEY, left);
}

/** Record a decision. It takes effect on this device immediately (a flagged
 * clip stops playing at once); the proxy copy makes it true for the other
 * profile too, and is retried later if we are offline. */
export async function markClip(args: {
  kind: AudioKind;
  id: string;
  hash: string;
  status: 'verified' | 'flagged';
  text: string;
  profileId: string;
}): Promise<void> {
  const key = clipKey(args.kind, args.id);
  const mark: AudioMark = {
    status: args.status,
    hash: args.hash,
    by: args.profileId,
    at: new Date().toISOString(),
    kind: args.kind,
    text: args.text,
  };
  const marks = { ...state.marks, [key]: mark };
  store(MARKS_KEY, marks);
  set({ marks });
  if (!(await postMark(key, mark, args.profileId))) {
    const pending = readStored(PENDING_KEY, PendingSchema) ?? [];
    store(PENDING_KEY, [...pending.filter((p) => p.key !== key), { key, mark, profileId: args.profileId }]);
  }
}

export interface ClipRef {
  kind: AudioKind;
  id: string;
  url: string;
  hash: string;
  text: string;
  zhuyin?: string;
}

/** The clip to offer for a word id, or a sentence id / exact sentence text. null = no button. */
export function findClip(
  s: Pick<State, 'manifest' | 'marks' | 'byText'>,
  ref: { kind: 'word'; id: string } | { kind: 'sentence'; id?: string; text?: string },
): ClipRef | null {
  const id = ref.kind === 'sentence' ? (ref.id && s.manifest?.sentences[ref.id] ? ref.id : s.byText.get(ref.text ?? '')) : ref.id;
  if (!id) return null;
  const clip = playableClip(s.manifest, s.marks, ref.kind, id, { allowSuspect: ALLOW_SUSPECT_AUDIO });
  if (!clip) return null;
  return {
    kind: ref.kind,
    id,
    url: clipUrl(clip.url),
    hash: clip.entry.hash,
    text: clip.entry.text,
    zhuyin: clip.entry.zhuyin,
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;
/** The current audio state, outside React. */
export const getAudioState = (): State => state;

export function useAudioState(): State {
  void loadAudio();
  // Phase 40 D.1: follow the active profile's tutoring clips (fetched once per profile switch)
  const profile = getActiveProfileForApi();
  if (profile && profile !== tutorLoadedFor) void loadTutorAudio(profile);
  return useSyncExternalStore(subscribe, snapshot);
}

// ---- playback -----------------------------------------------------------

export const SLOW_RATE = 0.75;
export const getSlow = (): boolean => {
  try {
    return localStorage.getItem(SLOW_KEY) === '1';
  } catch {
    return false;
  }
};
export const setSlow = (slow: boolean): void => {
  try {
    localStorage.setItem(SLOW_KEY, slow ? '1' : '0');
  } catch {
    /* ignore */
  }
  slowListeners.forEach((l) => l(slow));
};
/** Phase 21: the profile setting mirrors this (lib/audio-slow.ts), so it follows the profile and syncs. */
const slowListeners = new Set<(slow: boolean) => void>();
export function onSlowChange(l: (slow: boolean) => void): () => void {
  slowListeners.add(l);
  return () => slowListeners.delete(l);
}
/** Set from the synced profile setting without echoing it back. */
export function loadSlow(slow: boolean): void {
  try {
    localStorage.setItem(SLOW_KEY, slow ? '1' : '0');
  } catch {
    /* ignore */
  }
}

let current: { audio: HTMLAudioElement; objectUrl: string } | null = null;

export function stopAudio(): void {
  if (!current) return;
  current.audio.pause();
  URL.revokeObjectURL(current.objectUrl);
  current = null;
}

/** Play one clip at normal or slow speed (the audio element's playbackRate — no
 * second clip). Fetched whole so the service worker can cache it for offline.
 * Never called except from a tap. */
export async function playUrl(url: string, slow: boolean): Promise<void> {
  stopAudio();
  const res = await fetchClip(url);
  if (!res.ok) throw new Error(`clip ${res.status}`);
  const objectUrl = URL.createObjectURL(await res.blob());
  const audio = new Audio(objectUrl);
  audio.preservesPitch = true;
  audio.playbackRate = slow ? SLOW_RATE : 1;
  const mine = { audio, objectUrl };
  current = mine;
  audio.addEventListener('ended', () => {
    if (current === mine) stopAudio();
  });
  await audio.play();
}

/** Test hook: put the module back to a known state. */
export function __setAudioStateForTests(next: Partial<State>): void {
  loading = Promise.resolve();
  if ('manifest' in next && !('staticManifest' in next)) next = { staticManifest: next.manifest ?? null, tutor: null, ...next };
  set(next);
}
