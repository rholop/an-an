import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  AUDIO_VOICES,
  COURSE_BOOK_IDS,
  isTextbookTagged,
  SentenceBankFileSchema,
  levelIndex,
  sentenceSsml,
  wordSsml,
  type AudioKind,
  type Level,
  type Lexicon,
  type SentenceBankEntry,
} from '@anan/core';

/** One thing to say. `buildSsml(voice, explicit)` returns null when no trustworthy SSML exists. */
export interface AudioJob {
  kind: AudioKind;
  id: string;
  text: string;
  zhuyin?: string;
  buildSsml(voice: string, explicit: boolean): string | null;
}

export interface SkippedClip {
  kind: AudioKind;
  id: string;
  text: string;
  reason: string;
}

export const DEFAULT_LEVELS: Level[] = ['N1', 'N2', 'L1', 'L2'];

/** Phase 35: a word in any textbook of the course (core, supplementary or extra lesson words). */
const inAnyTextbook = (tags: readonly string[]): boolean => COURSE_BOOK_IDS.some((b) => isTextbookTagged(tags, b));

/** Words in `levels`, plus every textbook word whatever its level (Phase 35).
 * `textbook` counts the jobs that are textbook words. */
export function wordJobs(
  lexicon: Lexicon,
  levels: readonly Level[],
): { jobs: AudioJob[]; skipped: SkippedClip[]; textbook: number } {
  const jobs: AudioJob[] = [];
  const skipped: SkippedClip[] = [];
  const seen = new Set<string>();
  let textbook = 0;
  for (const w of lexicon.allWords()) {
    if (seen.has(w.id)) continue;
    const fromBook = inAnyTextbook(w.tags);
    if (!fromBook && (!w.level || !levels.includes(w.level))) continue;
    seen.add(w.id);
    const build = (voice: string, explicit: boolean) =>
      explicit ? perSyllableSsml(w.headword, w.zhuyin, voice) : wordSsml(w.headword, w.zhuyin, voice);
    if (!build(AUDIO_VOICES.female, false)) {
      skipped.push({ kind: 'word', id: w.id, text: w.headword, reason: `zhuyin "${w.zhuyin}" doesn't fit the characters` });
      continue;
    }
    jobs.push({ kind: 'word', id: w.id, text: w.headword, zhuyin: w.zhuyin, buildSsml: build });
    if (fromBook) textbook++;
  }
  return { jobs, skipped, textbook };
}

/** Fallback for a word whose whole-word tag didn't help: tag every character on its own. */
function perSyllableSsml(headword: string, zhuyin: string, voice: string): string | null {
  const chars = [...headword];
  const syl = zhuyin.trim().split(/\s+/);
  if (chars.length !== syl.length) return null;
  const parts = chars.map((c, i) => wordSsml(c, syl[i]!, voice));
  if (parts.some((p) => p === null)) return null;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${voice}">${parts
    .map((p) => p!.replace(/^.*?<voice[^>]*>/, '').replace('</voice></speak>', ''))
    .join('')}</voice></speak>`;
}

export function sentenceJobs(
  lexicon: Lexicon,
  sentences: readonly SentenceBankEntry[],
  opts: { acceptMedium?: boolean } = {},
): { jobs: AudioJob[]; skipped: SkippedClip[] } {
  const jobs: AudioJob[] = [];
  const skipped: SkippedClip[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const plan = sentenceSsml(s.zh, lexicon, AUDIO_VOICES.female, opts);
    if (!plan.ok) {
      skipped.push({ kind: 'sentence', id: s.id, text: s.zh, reason: plan.reason });
      continue;
    }
    jobs.push({
      kind: 'sentence',
      id: s.id,
      text: s.zh,
      // `explicit` = the fallback after a flag: force every token we can read with confidence
      buildSsml: (voice, explicit) => {
        const p = sentenceSsml(s.zh, lexicon, voice, { ...opts, acceptMedium: opts.acceptMedium || explicit });
        return p.ok ? p.ssml : null;
      },
    });
  }
  return { jobs, skipped };
}

/** data/build/sentences.v1.<level>.json for the chosen levels. */
export function loadBankSentences(buildDir: string, levels: readonly Level[]): SentenceBankEntry[] {
  if (!existsSync(buildDir)) return [];
  const out: SentenceBankEntry[] = [];
  for (const f of readdirSync(buildDir)) {
    const m = /^sentences\.v\d+\.([A-Z0-9]+)\.json$/.exec(f);
    if (!m || !levels.includes(m[1] as Level)) continue;
    out.push(...SentenceBankFileSchema.parse(JSON.parse(readFileSync(path.join(buildDir, f), 'utf8'))).sentences);
  }
  return out;
}

/**
 * Phase 35: the lesson practice sentences, at any level. These are
 * data/build/sentences.textbook-<book>.json, compiled by `curriculum:content`
 * from data/curriculum/<book>/content/L*.yaml only (with the ids the app
 * uses). Nothing under data/curriculum/<book>/private/ (dialogues, book
 * examples: OCAC text) is read here, so it can never become a public clip.
 */
export function loadLessonSentences(buildDir: string): SentenceBankEntry[] {
  if (!existsSync(buildDir)) return [];
  const out: SentenceBankEntry[] = [];
  for (const f of readdirSync(buildDir).sort()) {
    if (!/^sentences\.textbook-[a-z0-9-]+\.json$/.test(f)) continue;
    out.push(...SentenceBankFileSchema.parse(JSON.parse(readFileSync(path.join(buildDir, f), 'utf8'))).sentences);
  }
  return out;
}

/** Phase 9 live sentences, from the newest saved copy of each profile on the proxy's disk. */
export function loadLiveSentences(syncDir: string, levels: readonly Level[]): SentenceBankEntry[] {
  if (!existsSync(syncDir)) return [];
  const out: SentenceBankEntry[] = [];
  for (const profile of readdirSync(syncDir)) {
    const dir = path.join(syncDir, profile);
    let newest: { rev: number; file: string } | undefined;
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.\d+\.json\.gz$/.exec(f);
      if (m && (!newest || Number(m[1]) > newest.rev)) newest = { rev: Number(m[1]), file: f };
    }
    if (!newest) continue;
    const data = JSON.parse(gunzipSync(readFileSync(path.join(dir, newest.file))).toString('utf8')) as {
      liveSentences?: SentenceBankEntry[];
    };
    for (const s of data.liveSentences ?? []) {
      if (s.level && levelIndex(s.level) >= 0 && levels.includes(s.level)) out.push(s);
    }
  }
  return out;
}
