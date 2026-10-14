// Phase 40 Part A: fill `estimatedLevel` for every lexicon word without an official TOCFL level
// (TBCL first, when its list is in data/raw, then the word's characters). The official `level` is
// never touched. Used by build-lexicon (every build) and estimate-levels (`pnpm pipeline:levels`,
// patching an existing build).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { charLevelIndex, estimateWordLevel, TBCL_TO_LEVEL, type Level, type LevelSource, type Word } from '@anan/core';

/** The TBCL file names looked for in data/raw (the first that exists is read). */
export const TBCL_FILES = ['tbcl-words.xlsx', 'tbcl-words.csv', 'tbcl-words.tsv'];

const ZH_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };

/** "第3級" / "3" / "三級" / "Level 3" → 3. */
export function parseTbclLevel(raw: unknown): number | undefined {
  const s = String(raw ?? '').trim();
  const d = s.match(/[1-7]/);
  if (d) return Number(d[0]);
  const z = [...s].find((c) => ZH_DIGITS[c]);
  return z ? ZH_DIGITS[z] : undefined;
}

/**
 * Rows of a TBCL word list (header row first): the word column (詞語 / 詞彙 / word) and the level
 * column (等級 / 級別 / level). A word listed at several levels keeps the lowest. Several forms in
 * one cell ("爸爸/爸") are each listed.
 */
export function tbclFromRows(rows: unknown[][]): Map<string, Level> {
  const out = new Map<string, Level>();
  const header = (rows[0] ?? []).map((h) => String(h ?? ''));
  const wordCol = header.findIndex((h) => /詞語|詞彙|詞目|word/i.test(h));
  const levelCol = header.findIndex((h) => /等級|級別|級數|level/i.test(h));
  if (wordCol < 0 || levelCol < 0) throw new Error(`TBCL file: no word / level column in header (${header.join(', ')})`);
  for (const row of rows.slice(1)) {
    const n = parseTbclLevel(row[levelCol]);
    const lv = n ? TBCL_TO_LEVEL[n] : undefined;
    if (!lv) continue;
    for (const form of String(row[wordCol] ?? '').split(/[/、,，|()（）]/)) {
      const w = form.trim();
      if (!w || !/\p{Script=Han}/u.test(w)) continue;
      const cur = out.get(w);
      if (!cur || TBCL_ORDER.indexOf(lv) < TBCL_ORDER.indexOf(cur)) out.set(w, lv);
    }
  }
  return out;
}
const TBCL_ORDER: readonly Level[] = Object.values(TBCL_TO_LEVEL);

/** The TBCL list from data/raw, or undefined when it isn't there (the build then skips it). */
export function loadTbcl(rawDir: string): { words: Map<string, Level>; file: string } | undefined {
  const file = TBCL_FILES.map((f) => path.join(rawDir, f)).find((f) => existsSync(f));
  if (!file) return undefined;
  let rows: unknown[][];
  if (file.endsWith('.xlsx')) {
    const book = XLSX.read(readFileSync(file));
    rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!]!, { header: 1 });
  } else {
    const sep = file.endsWith('.tsv') ? '\t' : ',';
    rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(sep));
  }
  return { words: tbclFromRows(rows), file: path.basename(file) };
}

export interface LevelEstimateStats {
  official: number;
  bySource: Record<Exclude<LevelSource, 'tocfl' | 'model'>, number>;
  none: number;
  tbclFile?: string;
  samples: Array<Pick<Word, 'id' | 'headword' | 'estimatedLevel' | 'levelSource'>>;
}

/** Sets (or clears) `estimatedLevel` / `levelSource` on every word, in place. Deterministic. */
export function applyLevelEstimates(words: Word[], tbcl?: { words: ReadonlyMap<string, Level>; file: string }): LevelEstimateStats {
  const chars = charLevelIndex(words);
  const stats: LevelEstimateStats = { official: 0, bySource: { tbcl: 0, chars: 0 }, none: 0, samples: [], ...(tbcl ? { tbclFile: tbcl.file } : {}) };
  const estimated: Word[] = [];
  for (const w of words) {
    delete w.estimatedLevel;
    delete w.levelSource;
    if (w.level) {
      stats.official++;
      continue;
    }
    const e = estimateWordLevel(w, { chars, ...(tbcl ? { tbcl: tbcl.words } : {}) });
    if (!e) {
      stats.none++;
      continue;
    }
    w.estimatedLevel = e.estimatedLevel;
    w.levelSource = e.levelSource;
    stats.bySource[e.levelSource as 'tbcl' | 'chars']++;
    estimated.push(w);
  }
  // 50 evenly spaced samples for the report
  const n = Math.min(50, estimated.length);
  for (let i = 0; i < n; i++) {
    const w = estimated[Math.floor((i * estimated.length) / n)]!;
    stats.samples.push({ id: w.id, headword: w.headword, estimatedLevel: w.estimatedLevel, levelSource: w.levelSource });
  }
  return stats;
}

/** docs/level-estimates.md */
export function renderLevelReport(stats: LevelEstimateStats, words: readonly Word[]): string {
  const total = words.length;
  const pct = (n: number) => `${((100 * n) / Math.max(1, total)).toFixed(1)}%`;
  const per = new Map<string, number>();
  for (const w of words) if (w.estimatedLevel) per.set(w.estimatedLevel, (per.get(w.estimatedLevel) ?? 0) + 1);
  const lines = [
    '# Level estimates (Phase 40 Part A)',
    '',
    'Generated by `pnpm pipeline:levels` (also run by every `build:lexicon`). The official TOCFL `level` is unchanged;',
    'words without one get `estimatedLevel` (shown as "≈ L1"). The TOCFL gate, level mastery and the level-up prompt',
    'use the official level only.',
    '',
    `- Words: ${total}`,
    `- Official TOCFL level: ${stats.official} (${pct(stats.official)})`,
    `- Estimated from TBCL: ${stats.bySource.tbcl} (${pct(stats.bySource.tbcl)})${stats.tbclFile ? ` — from data/raw/${stats.tbclFile}` : ' — **TBCL not used**: no TBCL file in data/raw (see data/raw/SOURCES.md)'}`,
    `- Estimated from characters: ${stats.bySource.chars} (${pct(stats.bySource.chars)})`,
    `- No level and no estimate: ${stats.none} (${pct(stats.none)})`,
    '',
    '## Estimates per level',
    '',
    '| level | words |',
    '| --- | --- |',
    ...[...per].sort(([a], [b]) => a.localeCompare(b)).map(([lv, n]) => `| ${lv} | ${n} |`),
    '',
    '## 50 samples',
    '',
    '| word | estimate | source |',
    '| --- | --- | --- |',
    ...stats.samples.map((s) => `| ${s.headword} | ≈ ${s.estimatedLevel} | ${s.levelSource} |`),
    '',
  ];
  return lines.join('\n');
}
