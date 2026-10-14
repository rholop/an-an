// Phase 40 D.1: audio for tutoring words and kept sentences, made on the server at Save.
// The same engine as `audio:build` (@anan/audio-build: SSML rules, MOE readings, speech-to-text
// check, suspect policy); clips live under TUTOR_AUDIO_DIR/<profileId>/ with a per-profile
// manifest of the usual AudioManifest shape. Every route sits behind the household code (the
// /v1/* guard in app.ts), the files too: the web fetches them with the header and plays a blob.
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  AUDIO_VOICES,
  AudioKindSchema,
  isProfileId,
  Lexicon,
  type AudioManifest,
  type AudioManifestEntry,
  type GrammarItem,
  type Word,
} from '@anan/core';
import { buildAudio, emptyManifest, loadManifest, tutorJobs, type SpeechClient } from '@anan/audio-build';

export interface TutorAudioDeps {
  /** The Azure Speech client, or null when the server has no speech key (503 speech_not_configured). */
  client: SpeechClient | null;
  /** TUTOR_AUDIO_DIR: one folder per profile (manifest.json, words/, sentences/). */
  dir: string;
  /** The base word list, for sentence readings (loaded once, on first use). */
  lexicon: () => Promise<Lexicon>;
  voice?: string;
  /** How long one request may spend making clips; the rest come back as `pending` (default 40 s,
   * under nginx's 60 s proxy timeout). The app asks again until nothing is pending. */
  timeBudgetMs?: number;
  now?: () => Date;
}

const Id = z.string().regex(/^[\w:.-]{1,160}$/);
const hasHan = (s: string) => /\p{Script=Han}/u.test(s);

export const TUTOR_AUDIO_MAX_ITEMS = 200;

export const TutorAudioRequestSchema = z.object({
  profileId: z.string().refine(isProfileId, 'unknown profile'),
  sessionId: Id,
  items: z
    .array(
      z.object({
        kind: AudioKindSchema,
        id: Id,
        text: z.string().min(1).max(200).refine(hasHan, 'no Chinese text'),
        zhuyin: z.string().max(200).optional(),
        pinyinNumeric: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(TUTOR_AUDIO_MAX_ITEMS),
});
export type TutorAudioRequest = z.infer<typeof TutorAudioRequestSchema>;

export interface TutorAudioResponse {
  /** The profile's manifest entries for the requested items that have a clip. */
  entries: { words: Record<string, AudioManifestEntry>; sentences: Record<string, AudioManifestEntry> };
  counts: { requested: number; made: number; unchanged: number; suspect: number; failed: number; skipped: number; pending: number };
  /** Azure or the check failed: nothing stored, asked again next time. */
  failed: Array<{ kind: 'word' | 'sentence'; id: string; reason: string }>;
  /** No trustworthy SSML (reading not certain, zhuyin doesn't fit): no clip, like audio:build. */
  skipped: Array<{ kind: 'word' | 'sentence'; id: string; reason: string }>;
}

const TIME_BUDGET = 'time budget for this request used';

/** Serialises the work per profile (the manifest file is read, changed and written back). */
class ProfileLocks {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

const profileDir = (deps: TutorAudioDeps, profileId: string) => path.join(deps.dir, profileId);

export function tutorAudioManifest(deps: TutorAudioDeps, profileId: string, now: Date): AudioManifest {
  const voice = deps.voice ?? AUDIO_VOICES.female;
  const file = path.join(profileDir(deps, profileId), 'manifest.json');
  return existsSync(file) ? loadManifest(file, now, voice) : emptyManifest(now, voice);
}

export function registerTutorAudioRoutes(
  app: Hono,
  deps: TutorAudioDeps | undefined,
  log: (entry: Record<string, unknown>) => void,
): void {
  const locks = new ProfileLocks();
  const now = () => deps?.now?.() ?? new Date();
  const notConfigured = { error: 'speech_not_configured' } as const;

  app.post(
    '/v1/tutor-audio',
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'too large' }, 413) }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      const parsed = TutorAudioRequestSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid tutor audio request', issues: parsed.error.issues.slice(0, 5) }, 400);
      if (!deps?.client) return c.json(notConfigured, 503);
      const client = deps.client;
      const { profileId, sessionId, items } = parsed.data;

      const { jobs, skipped } = tutorJobs(await deps.lexicon(), items);
      const started = Date.now();
      const budget = deps.timeBudgetMs ?? 40_000;
      const res = await locks.run(profileId, () =>
        buildAudio(jobs, {
          outDir: profileDir(deps, profileId),
          client,
          voice: deps.voice ?? AUDIO_VOICES.female,
          now: now(),
          shouldStop: () => (Date.now() - started > budget ? TIME_BUDGET : null),
          log: (m) => log({ route: 'POST /v1/tutor-audio', profileId, note: m }),
        }),
      );
      if (res.stoppedEarly && res.stoppedEarly !== TIME_BUDGET) {
        // a wrong key or region (401/403): every other clip would fail the same way
        log({ route: 'POST /v1/tutor-audio', profileId, sessionId, error: res.stoppedEarly });
        return c.json({ error: 'speech_error', message: res.stoppedEarly.slice(0, 300) }, 502);
      }
      const entries: TutorAudioResponse['entries'] = { words: {}, sentences: {} };
      for (const it of items) {
        const e = (it.kind === 'word' ? res.manifest.words : res.manifest.sentences)[it.id];
        if (e) (it.kind === 'word' ? entries.words : entries.sentences)[it.id] = e;
      }
      const failed = res.failedKeys.map((key, i) => {
        const [kind, ...rest] = key.split(':');
        return { kind: kind as 'word' | 'sentence', id: rest.join(':'), reason: res.failedReasons[i] ?? 'failed' };
      });
      const out: TutorAudioResponse = {
        entries,
        counts: {
          requested: items.length,
          made: res.made,
          unchanged: res.unchanged,
          suspect: res.suspect,
          failed: res.failed,
          skipped: skipped.length,
          pending: res.notReached,
        },
        failed,
        skipped: skipped.map((s) => ({ kind: s.kind, id: s.id, reason: s.reason })),
      };
      log({ route: 'POST /v1/tutor-audio', profileId, sessionId, ...out.counts, billedChars: client.usage.billedChars });
      return c.json(out);
    },
  );

  /** The profile's clip manifest (merged into the static one by the app); `configured` = the speech key is set. */
  app.get('/v1/tutor-audio/manifest', (c) => {
    const profileId = c.req.query('profileId');
    if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
    const manifest = deps ? tutorAudioManifest(deps, profileId, now()) : emptyManifest(now(), AUDIO_VOICES.female);
    return c.json({ configured: !!deps?.client, manifest }, 200, { 'cache-control': 'private, no-cache' });
  });

  /** One clip. The URL carries ?v=<hash>, so a re-made clip is a new URL. */
  app.get('/v1/tutor-audio/file/:profileId/:folder/:name', async (c) => {
    const { profileId, folder, name } = c.req.param();
    if (!deps || !isProfileId(profileId) || (folder !== 'words' && folder !== 'sentences') || !/^[\w-][\w.-]*\.mp3$/.test(name))
      return c.json({ error: 'not found' }, 404);
    const base = path.resolve(profileDir(deps, profileId), folder);
    const abs = path.resolve(base, name);
    if (path.dirname(abs) !== base) return c.json({ error: 'not found' }, 404);
    try {
      const mp3 = await readFile(abs);
      return c.body(new Uint8Array(mp3), 200, {
        'content-type': 'audio/mpeg',
        'cache-control': 'private, max-age=31536000, immutable',
      });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });
}

/** The word list for sentence readings, keeping only what segmenting and reading use (the full
 * file is ~60 MB in memory; the proxy restarts at 300 MB). */
export function loadReadingLexicon(file: string): Lexicon {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { words: Word[]; grammar?: GrammarItem[] };
  const words: Word[] = raw.words.map((w) => ({
    id: w.id,
    headword: w.headword,
    variants: w.variants ?? [],
    pos: [],
    level: w.level,
    source: w.source,
    pinyin: w.pinyin,
    pinyinNumeric: w.pinyinNumeric,
    zhuyin: w.zhuyin,
    glossEn: '',
    chars: [],
    tags: [],
    ...(w.freqRank !== undefined ? { freqRank: w.freqRank } : {}),
  }));
  return new Lexicon(words, []);
}

/** Loaded on the first request that needs it, then kept. */
export function lazyLexicon(file: string): () => Promise<Lexicon> {
  let lex: Promise<Lexicon> | null = null;
  return () => {
    lex ??= Promise.resolve().then(() => loadReadingLexicon(file));
    lex.catch(() => (lex = null));
    return lex;
  };
}
