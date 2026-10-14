import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { SentenceBankFileSchema, levelIndex, type Level, type SentenceBankEntry } from '@anan/core';

// audio:build's inputs, read from data/build and the proxy's sync copies. The jobs, the SSML and
// the Azure engine live in @anan/audio-build (Phase 40: shared with the proxy's /v1/tutor-audio).

export const DEFAULT_LEVELS: Level[] = ['N1', 'N2', 'L1', 'L2'];

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
