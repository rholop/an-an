import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  AUDIO_VOICES,
  AudioManifestSchema,
  clipKey,
  type AudioManifest,
  type AudioManifestEntry,
  type AudioMark,
} from '@anan/core';
import { SpeechError, type SpeechClient } from './azure.js';
import { recognisedMatches } from './compare.js';
import type { AudioJob } from './inputs.js';

export const ssmlHash = (voice: string, ssml: string): string =>
  createHash('sha256').update(`${voice}\n${ssml}`).digest('hex');

export const emptyManifest = (now: Date, voice: string): AudioManifest => ({
  meta: { version: 1, builtAt: now.toISOString(), voice },
  words: {},
  sentences: {},
});

export function loadManifest(file: string, now: Date, voice: string): AudioManifest {
  if (!existsSync(file)) return emptyManifest(now, voice);
  return AudioManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function saveManifest(file: string, manifest: AudioManifest): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 1));
  renameSync(tmp, file);
}

export const otherVoice = (voice: string): string =>
  voice === AUDIO_VOICES.female ? AUDIO_VOICES.male : AUDIO_VOICES.female;

export interface BuildOptions {
  outDir: string;
  client: SpeechClient;
  voice: string;
  now: Date;
  /** Stop (cleanly) once this many billed characters have been used this run. */
  maxChars?: number;
  /** Re-roll clips that were `suspect` last time (same voice and SSML). See `fixSuspect`. */
  retrySuspect?: boolean;
  log?: (msg: string) => void;
}

export interface BuildResult {
  manifest: AudioManifest;
  made: number;
  unchanged: number;
  suspect: number;
  failed: number;
  stoppedEarly: string | null;
}

const section = (m: AudioManifest, kind: AudioJob['kind']) => (kind === 'word' ? m.words : m.sentences);
const fileFor = (job: AudioJob) => `${job.kind === 'word' ? 'words' : 'sentences'}/${job.id}.mp3`;

/** Synthesize one clip, run the automatic check, write the file (to `writeTo`
 * under the audio root when given; the entry still names the real file). */
async function makeClip(
  job: AudioJob,
  ssml: string,
  voice: string,
  opts: BuildOptions,
  writeTo?: string,
): Promise<AudioManifestEntry> {
  const mp3 = await opts.client.synthesize(ssml);
  const file = fileFor(job);
  const abs = path.join(opts.outDir, writeTo ?? file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, mp3);
  const heard = await opts.client.transcribe(ssml, mp3);
  const ok = recognisedMatches(job.text, heard);
  return {
    file,
    voice,
    hash: ssmlHash(voice, ssml),
    status: ok ? 'auto_ok' : 'suspect',
    text: job.text,
    ...(job.zhuyin ? { zhuyin: job.zhuyin } : {}),
    ...(ok ? {} : { heard }),
  };
}

/** `audio:build`: make every clip that is missing or whose SSML changed. A
 * rebuild with nothing changed makes zero Azure calls. */
export async function buildAudio(jobs: readonly AudioJob[], opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? (() => undefined);
  const manifestFile = path.join(opts.outDir, 'manifest.json');
  const manifest = loadManifest(manifestFile, opts.now, opts.voice);
  manifest.meta = { version: 1, builtAt: opts.now.toISOString(), voice: opts.voice };
  const result: BuildResult = { manifest, made: 0, unchanged: 0, suspect: 0, failed: 0, stoppedEarly: null };

  let sinceSave = 0;
  try {
    for (const job of jobs) {
      const ssml = job.buildSsml(opts.voice, false);
      if (!ssml) continue;
      const prev = section(manifest, job.kind)[job.id];
      const sameClip =
        prev && (prev.fixed ? prev.text === job.text : prev.hash === ssmlHash(prev.voice, ssml));
      if (
        sameClip &&
        existsSync(path.join(opts.outDir, prev.file)) &&
        !(prev.status === 'suspect' && opts.retrySuspect)
      ) {
        result.unchanged++;
        continue;
      }
      if (opts.maxChars !== undefined && opts.client.usage.billedChars >= opts.maxChars) {
        result.stoppedEarly = `character budget reached (${opts.client.usage.billedChars} billed this run)`;
        break;
      }
      try {
        const entry = await makeClip(job, ssml, opts.voice, opts);
        section(manifest, job.kind)[job.id] = entry;
        result.made++;
        if (entry.status === 'suspect') {
          result.suspect++;
          log(`suspect ${job.kind} ${job.id} "${job.text}": heard "${entry.heard}"`);
        }
        if (++sinceSave >= 25) {
          saveManifest(manifestFile, manifest);
          sinceSave = 0;
          log(`… ${result.made} made, ${opts.client.usage.billedChars} chars billed`);
        }
      } catch (err) {
        if (err instanceof SpeechError && err.fatal) {
          result.stoppedEarly = String(err.message);
          break;
        }
        result.failed++;
        log(`failed ${job.kind} ${job.id} "${job.text}": ${String(err)}`);
      }
    }
  } finally {
    saveManifest(manifestFile, manifest);
  }
  return result;
}

/** The three ways to re-make a clip, in order (Phase 10 flags, Phase 35 suspects). */
export const FIX_ATTEMPTS = [
  { name: 'other voice', otherVoice: true, explicit: false },
  { name: 'explicit readings', otherVoice: false, explicit: true },
  { name: 'other voice + explicit readings', otherVoice: true, explicit: true },
] as const;

interface FixTry {
  /** The first attempt that came back `auto_ok`. */
  done?: AudioManifestEntry & { fixedBy: string };
  /** The last attempt that made a clip but failed the check. */
  lastBad?: AudioManifestEntry;
  /** What each attempt that made a clip was heard as. */
  attempts: { attempt: string; heard: string }[];
  /** Set when the run must stop (fatal Azure error or the character budget). */
  stop?: string;
}

/**
 * Try the other voice, then explicit per-syllable readings with the original
 * voice, then both. Each attempt is written to its own temporary file; the
 * clip that is kept (`done`, or `lastBad` when `adoptBad`) is moved into place
 * and the rest are deleted, so the current clip is untouched unless replaced.
 */
async function tryFixes(
  job: AudioJob,
  prev: AudioManifestEntry,
  opts: BuildOptions,
  adoptBad: boolean,
): Promise<FixTry> {
  const out: FixTry = { attempts: [] };
  const file = fileFor(job);
  const temps: string[] = [];
  let keep: string | undefined;
  try {
    for (const [i, a] of FIX_ATTEMPTS.entries()) {
      const voice = a.otherVoice ? otherVoice(prev.voice) : prev.voice;
      const ssml = job.buildSsml(voice, a.explicit);
      if (!ssml || ssmlHash(voice, ssml) === prev.hash) continue;
      if (opts.maxChars !== undefined && opts.client.usage.billedChars >= opts.maxChars) {
        out.stop = `character budget reached (${opts.client.usage.billedChars} billed this run)`;
        return out;
      }
      const tmp = `${file}.try${i}`;
      temps.push(tmp);
      try {
        const entry = await makeClip(job, ssml, voice, opts, tmp);
        out.attempts.push({ attempt: a.name, heard: entry.status === 'auto_ok' ? job.text : (entry.heard ?? '') });
        if (entry.status === 'auto_ok') {
          out.done = { ...entry, fixedBy: a.name };
          keep = tmp;
          break;
        }
        out.lastBad = entry;
        if (adoptBad) keep = tmp;
      } catch (err) {
        if (err instanceof SpeechError && err.fatal) {
          out.stop = err.message;
          return out;
        }
        opts.log?.(`failed retry for ${clipKey(job.kind, job.id)}: ${String(err)}`);
      }
    }
    if (keep) renameSync(path.join(opts.outDir, keep), path.join(opts.outDir, file));
    return out;
  } finally {
    for (const t of temps) if (t !== keep || out.stop) rmSync(path.join(opts.outDir, t), { force: true });
  }
}

export interface FixResult {
  fixed: string[];
  stillBad: string[];
  /** Flagged clips that no longer exist in the inputs. */
  missing: string[];
  stoppedEarly: string | null;
}

/**
 * `audio:build --only-flagged`: for each clip a person flagged (and that is
 * still the same clip), try (a) the other voice, then (b) explicit phoneme
 * tags with the original voice, then (c) explicit tags with the other voice.
 * A passing result is `auto_ok` again, with a new hash — which is what retires
 * the old flag everywhere. If nothing passes the clip stays out as `suspect`.
 */
export async function fixFlagged(
  jobs: readonly AudioJob[],
  flagged: Readonly<Record<string, Pick<AudioMark, 'hash' | 'status'>>>,
  opts: BuildOptions,
): Promise<FixResult> {
  const manifestFile = path.join(opts.outDir, 'manifest.json');
  const manifest = loadManifest(manifestFile, opts.now, opts.voice);
  const result: FixResult = { fixed: [], stillBad: [], missing: [], stoppedEarly: null };
  const byKey = new Map(jobs.map((j) => [clipKey(j.kind, j.id), j]));

  try {
    for (const [key, mark] of Object.entries(flagged)) {
      if (mark.status !== 'flagged') continue;
      const job = byKey.get(key);
      const prev = job && section(manifest, job.kind)[job.id];
      if (!job || !prev) {
        result.missing.push(key);
        continue;
      }
      if (prev.hash !== mark.hash) continue; // already regenerated since the flag
      const t = await tryFixes(job, prev, opts, true);
      if (t.stop) {
        result.stoppedEarly = t.stop;
        return result;
      }
      const { done, lastBad } = t;
      if (done) {
        section(manifest, job.kind)[job.id] = { ...done, fixed: true };
        result.fixed.push(key);
      } else {
        // never leave the flagged clip playable: replace with the last failed try (suspect) or mark the old one suspect
        section(manifest, job.kind)[job.id] = lastBad ?? { ...prev, status: 'suspect', heard: '(flagged; no regeneration passed)' };
        result.stillBad.push(key);
      }
    }
  } finally {
    saveManifest(manifestFile, manifest);
  }
  return result;
}

export interface SuspectFixResult {
  /** Suspects tried this run. */
  tried: string[];
  fixed: string[];
  stillSuspect: string[];
  stoppedEarly: string | null;
}

/** Suspect clips `fixSuspect` would try: in the inputs and not yet tried (unless `again`). */
export function suspectsToFix(
  jobs: readonly AudioJob[],
  manifest: AudioManifest,
  again = false,
): { job: AudioJob; prev: AudioManifestEntry }[] {
  const out: { job: AudioJob; prev: AudioManifestEntry }[] = [];
  for (const job of jobs) {
    const prev = section(manifest, job.kind)[job.id];
    if (prev?.status === 'suspect' && (again || !prev.fixTried)) out.push({ job, prev });
  }
  return out;
}

/**
 * Phase 35, `audio:build --fix-suspect`: the same three attempts as
 * `fixFlagged`, on every `suspect` clip. The first `auto_ok` attempt replaces
 * the clip (`fixed: true`). If none passes, the current clip and status stay
 * exactly as they were (suspect clips still play) and `fixTried` is recorded,
 * so a later run skips it unless `again`.
 */
export async function fixSuspect(
  jobs: readonly AudioJob[],
  opts: BuildOptions & { again?: boolean },
): Promise<SuspectFixResult> {
  const manifestFile = path.join(opts.outDir, 'manifest.json');
  const manifest = loadManifest(manifestFile, opts.now, opts.voice);
  const result: SuspectFixResult = { tried: [], fixed: [], stillSuspect: [], stoppedEarly: null };
  let sinceSave = 0;
  try {
    for (const { job, prev } of suspectsToFix(jobs, manifest, opts.again)) {
      const key = clipKey(job.kind, job.id);
      const t = await tryFixes(job, prev, opts, false);
      if (t.stop) {
        result.stoppedEarly = t.stop;
        break;
      }
      result.tried.push(key);
      if (t.done) {
        section(manifest, job.kind)[job.id] = {
          ...t.done,
          fixed: true,
          ...(prev.heard !== undefined ? { suspectHeard: prev.heard } : {}),
          fixAttempts: t.attempts,
        };
        result.fixed.push(key);
        opts.log?.(`fixed ${key} "${job.text}" with ${t.done.fixedBy}`);
      } else {
        section(manifest, job.kind)[job.id] = { ...prev, fixTried: opts.now.toISOString(), fixAttempts: t.attempts };
        result.stillSuspect.push(key);
        opts.log?.(`still suspect ${key} "${job.text}": heard ${t.attempts.map((a) => `"${a.heard}"`).join(', ') || '(no other reading to try)'}`);
      }
      if (++sinceSave >= 10) {
        saveManifest(manifestFile, manifest);
        sinceSave = 0;
      }
    }
  } finally {
    saveManifest(manifestFile, manifest);
  }
  return result;
}
