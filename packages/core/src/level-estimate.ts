// Phase 40 Part A: every word gets a level. The official TOCFL `level` stays the only level the
// TOCFL gate, level mastery and the level-up prompt use; everything else (displays, the Garden,
// level filters, scenario word lists, the vocabulary ladder, lookups, Cloze, story budgets) uses
// `displayLevel` = `level ?? estimatedLevel`. Estimates come from TBCL (when its list is in the
// build), else from the word's characters, else (tutoring Save only) one checked model call.
import { LEVEL_IDS, levelIndex, levelShort, type Level } from './levels.config.js';
import type { Word } from './types.js';

export type LevelSource = 'tocfl' | 'tbcl' | 'chars' | 'model';

/** TBCL (NAER) levels 1–7 → app levels. */
export const TBCL_TO_LEVEL: Readonly<Record<number, Level>> = { 1: 'N1', 2: 'N2', 3: 'L1', 4: 'L2', 5: 'L3', 6: 'L4', 7: 'L5' };

/** The level every screen shows and ranks by (not the TOCFL gate or level mastery). */
export function displayLevel(w: Pick<Word, 'level'> & Partial<Pick<Word, 'estimatedLevel'>>): Level | null {
  return w.level ?? w.estimatedLevel ?? null;
}

/** True when the shown level is an estimate (shown with "≈"). */
export function isEstimatedLevel(w: Pick<Word, 'level'> & Partial<Pick<Word, 'estimatedLevel'>>): boolean {
  return !w.level && !!w.estimatedLevel;
}

/** "L1" or "≈ L1" (estimates), or undefined for a word with no level at all. */
export function displayLevelShort(w: Pick<Word, 'level'> & Partial<Pick<Word, 'estimatedLevel'>>): string | undefined {
  const lv = displayLevel(w);
  if (!lv) return undefined;
  return isEstimatedLevel(w) ? `≈ ${levelShort(lv)}` : levelShort(lv);
}

const maxLevel = (a: Level, b: Level): Level => (levelIndex(a) >= levelIndex(b) ? a : b);

export interface CharLevelIndex {
  /** The character's own single-character word's official level, else the lowest official level of
   * any word that contains it, else undefined. */
  levelOf(ch: string): Level | undefined;
}

/** Builds the character index from the word list (official TOCFL levels only, so estimates never
 * feed estimates). */
export function charLevelIndex(words: Iterable<Pick<Word, 'headword' | 'level'>>): CharLevelIndex {
  const own = new Map<string, Level>();
  const within = new Map<string, Level>();
  const lower = (m: Map<string, Level>, ch: string, lv: Level) => {
    const cur = m.get(ch);
    if (!cur || levelIndex(lv) < levelIndex(cur)) m.set(ch, lv);
  };
  for (const w of words) {
    if (!w.level) continue;
    const chars = [...w.headword];
    if (chars.length === 1) lower(own, chars[0]!, w.level);
    for (const ch of chars) lower(within, ch, w.level);
  }
  return { levelOf: (ch) => own.get(ch) ?? within.get(ch) };
}

/**
 * Part A.2.2: the highest level among the word's characters, one step up for words of three or
 * more characters (capped at L5). Undefined when a character has no level anywhere.
 * 早餐 → 早 (N1), 餐 (L1) → L1.
 */
export function estimateLevelFromChars(headword: string, index: CharLevelIndex): Level | undefined {
  const chars = [...headword].filter((c) => /\p{Script=Han}/u.test(c));
  if (chars.length === 0) return undefined;
  let lv: Level | undefined;
  for (const ch of chars) {
    const l = index.levelOf(ch);
    if (!l) return undefined;
    lv = lv ? maxLevel(lv, l) : l;
  }
  if (!lv) return undefined;
  if (chars.length >= 3) lv = LEVEL_IDS[Math.min(levelIndex(lv) + 1, LEVEL_IDS.length - 1)]!;
  return lv;
}

/** Part A.2: one word's estimate (TBCL first, then characters). An official level needs none. */
export function estimateWordLevel(
  w: Pick<Word, 'headword' | 'level'>,
  sources: { tbcl?: ReadonlyMap<string, Level>; chars: CharLevelIndex },
): { estimatedLevel: Level; levelSource: LevelSource } | undefined {
  if (w.level) return undefined;
  const t = sources.tbcl?.get(w.headword);
  if (t) return { estimatedLevel: t, levelSource: 'tbcl' };
  const c = estimateLevelFromChars(w.headword, sources.chars);
  return c ? { estimatedLevel: c, levelSource: 'chars' } : undefined;
}
