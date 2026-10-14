// Phase 40 D.1: audio for a class's words and kept sentences, made by the proxy at Save
// (POST /v1/tutor-audio: Azure Speech zh-TW, the same SSML rules, MOE readings and
// speech-to-text check as audio:build). The clips join the audio state (`loadTutorAudio`), so
// speaker buttons, `findClip` and listening cards work for tutoring words like any other.
import { AudioManifestEntrySchema, type AudioManifest, type TutorSessionRecord } from '@anan/core';
import { z } from 'zod';
import { authHeaders, handleUnauthorized, proxyBase } from '../api.js';
import { getAudioState, loadTutorAudio, setTutorManifest, setTutorSpeechState, useAudioState } from '../audio.js';

export { loadTutorAudio };

/** What the class page shows: made, still suspect, failed (Azure or the check), skipped (no sure reading). */
export interface TutorAudioResult {
  /** `speech_not_configured`: the server has no speech key yet ("Audio: waiting for the server's speech key"). */
  status: 'ok' | 'speech_not_configured' | 'error';
  made: number;
  suspect: number;
  failed: number;
  skipped: number;
  unchanged: number;
  /** Items still to make when the rounds ran out (asked again next time). */
  pending: number;
}

export interface TutorAudioItem {
  kind: 'word' | 'sentence';
  id: string;
  text: string;
  zhuyin?: string;
}

/** The proxy's limit per request. */
const MAX_ITEMS = 200;

const ResponseSchema = z.object({
  entries: z.object({ words: z.record(AudioManifestEntrySchema), sentences: z.record(AudioManifestEntrySchema) }),
  counts: z.object({
    made: z.number(),
    unchanged: z.number(),
    suspect: z.number(),
    failed: z.number(),
    skipped: z.number(),
    pending: z.number(),
  }),
  failed: z.array(z.object({ kind: z.enum(['word', 'sentence']), id: z.string() })),
  skipped: z.array(z.object({ kind: z.enum(['word', 'sentence']), id: z.string() })),
});

/**
 * The session's words (all of them: the caller filters to the ticked ones) and its practice
 * sentences. A word or sentence that already has a clip in the build's static manifest is left
 * out (the static clip wins anyway; no Azure characters spent).
 */
export function tutorAudioItems(
  session: Pick<TutorSessionRecord, 'words' | 'sentences'>,
  staticManifest: AudioManifest | null = null,
): TutorAudioItem[] {
  const out: TutorAudioItem[] = [];
  const seen = new Set<string>();
  for (const w of session.words) {
    if (seen.has(w.wordId) || staticManifest?.words[w.wordId]) continue;
    seen.add(w.wordId);
    out.push({ kind: 'word', id: w.wordId, text: w.zh, ...(w.zhuyin ? { zhuyin: w.zhuyin } : {}) });
  }
  const staticTexts = new Set(Object.values(staticManifest?.sentences ?? {}).map((e) => e.text));
  for (const s of session.sentences) {
    if (!s.practice || !s.zh || staticManifest?.sentences[s.id] || staticTexts.has(s.zh)) continue;
    out.push({ kind: 'sentence', id: s.id, text: s.zh });
  }
  return out;
}

/**
 * Ask the proxy for the session's clips. A request makes what fits in its time budget and reports
 * the rest as pending, so this asks again (only for those) up to `maxRounds` times. Every clip made
 * joins the audio state at once.
 */
export async function requestTutorAudio(
  session: Pick<TutorSessionRecord, 'id' | 'words' | 'sentences'>,
  profileId: string,
  opts: { fetchFn?: typeof fetch; maxRounds?: number; staticManifest?: AudioManifest | null } = {},
): Promise<TutorAudioResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const result: TutorAudioResult = { status: 'ok', made: 0, suspect: 0, failed: 0, skipped: 0, unchanged: 0, pending: 0 };
  let todo = tutorAudioItems(session, opts.staticManifest === undefined ? (getAudioState().staticManifest ?? null) : opts.staticManifest);
  for (let round = 0; todo.length > 0 && round < (opts.maxRounds ?? 8); round++) {
    const batch = todo.slice(0, MAX_ITEMS);
    let res: Response;
    try {
      res = await fetchFn(`${proxyBase()}/v1/tutor-audio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ profileId, sessionId: session.id, items: batch }),
      });
    } catch {
      return { ...result, status: 'error', pending: todo.length };
    }
    if (res.status === 503) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'speech_not_configured') {
        setTutorSpeechState('not_configured');
        return { ...result, status: 'speech_not_configured', pending: todo.length };
      }
      return { ...result, status: 'error', pending: todo.length };
    }
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) return { ...result, status: 'error', pending: todo.length };
    const parsed = ResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { ...result, status: 'error', pending: todo.length };
    const { entries, counts, failed, skipped } = parsed.data;
    result.made += counts.made;
    result.suspect += counts.suspect;
    result.failed += counts.failed;
    result.skipped += counts.skipped;
    result.unchanged += counts.unchanged;
    setTutorManifest(
      profileId,
      { meta: { version: 1, builtAt: new Date().toISOString(), voice: '' }, ...entries },
      { merge: true, speech: 'configured' },
    );
    // next round: only what this one didn't reach (made, unchanged, failed and skipped are settled)
    const settled = new Set([
      ...Object.keys(entries.words).map((id) => `word:${id}`),
      ...Object.keys(entries.sentences).map((id) => `sentence:${id}`),
      ...[...failed, ...skipped].map((f) => `${f.kind}:${f.id}`),
    ]);
    todo = [...batch.filter((it) => !settled.has(`${it.kind}:${it.id}`)), ...todo.slice(MAX_ITEMS)];
  }
  result.pending = todo.length;
  return result;
}

/** React helper for the class page: the server's speech state ('unknown' until the manifest loads). */
export function useTutorSpeechState() {
  const s = useAudioState();
  return s.tutorSpeech ?? 'unknown';
}
