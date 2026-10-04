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
import { authHeaders, handleUnauthorized, proxyBase } from './api.js';

// Phase 10: the web side of verified audio. The manifest (static, from the
// build) says what clips exist; the household's marks (from the proxy) say which
// ones people flagged or approved. `playableClip` in core is the only gate, and
// a clip with no manifest entry, or one flagged/suspect, simply has no button.

const MARKS_KEY = 'anan.audioMarks';
const PENDING_KEY = 'anan.audioPending';
const SLOW_KEY = 'anan.audioSlow';

interface State {
  manifest: AudioManifest | null;
  marks: Record<string, AudioMark>;
  /** exact sentence text -> sentence id, so any screen can ask "is there a clip for this line?" */
  byText: Map<string, string>;
}

let state: State = { manifest: null, marks: readStored(MARKS_KEY, z.record(AudioMarkSchema)) ?? {}, byText: new Map() };
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

let loading: Promise<void> | null = null;

/** Load the manifest and the household's marks (once; call `refreshAudio` to redo). */
export function loadAudio(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${audioBase()}manifest.json`);
      if (res.ok) {
        const manifest = AudioManifestSchema.parse(await res.json());
        const byText = new Map<string, string>();
        for (const [id, e] of Object.entries(manifest.sentences)) byText.set(e.text, id);
        set({ manifest, byText });
      }
    } catch {
      /* no audio built, or offline with nothing cached: no buttons */
    }
    await refreshMarks();
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
  s: State,
  ref: { kind: 'word'; id: string } | { kind: 'sentence'; id?: string; text?: string },
): ClipRef | null {
  const id = ref.kind === 'sentence' ? (ref.id && s.manifest?.sentences[ref.id] ? ref.id : s.byText.get(ref.text ?? '')) : ref.id;
  if (!id) return null;
  const clip = playableClip(s.manifest, s.marks, ref.kind, id);
  if (!clip) return null;
  return {
    kind: ref.kind,
    id,
    url: `${audioBase()}${clip.url}`,
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

export function useAudioState(): State {
  void loadAudio();
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
};

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
  const res = await fetch(url);
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
  set(next);
}
