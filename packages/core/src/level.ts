import type { Lexicon } from './lexicon.js';
import type { Token } from './segment.js';
import { levelIndex } from './levels.config.js';
import type { Level } from './types.js';

export function levelOf(token: Token, lexicon: Lexicon): Level | null {
  if (token.kind !== 'word') return null;
  const words = lexicon.lookup(token.text);
  // A word can appear at multiple senses/levels for the same spelling; report
  // the lowest (earliest-learned) level as the token's level.
  let best: Level | null = null;
  for (const w of words) {
    if (!w.level) continue;
    if (!best || levelIndex(w.level) < levelIndex(best)) best = w.level;
  }
  return best;
}

export interface CoverageResult {
  totalTokens: number;
  wordTokens: number;
  byLevel: Partial<Record<Level | 'unleveled', number>>;
  knownCount: number;
  unknownCount: number;
}

/**
 * Stub for Phase 3's coverage/pacing logic — for now just counts tokens per
 * level and how many are in the caller's known set. `knownSet` holds item
 * ids (Word.id) considered "known" by the learner model (Phase 2+); Phase 1
 * has no learner model, so callers may pass an empty set.
 */
export function coverage(
  tokens: Token[],
  lexicon: Lexicon,
  knownSet: ReadonlySet<string>,
): CoverageResult {
  const byLevel: CoverageResult['byLevel'] = {};
  let wordTokens = 0;
  let knownCount = 0;
  let unknownCount = 0;

  for (const token of tokens) {
    if (token.kind !== 'word') continue;
    wordTokens++;
    const words = lexicon.lookup(token.text);
    const level = levelOf(token, lexicon);
    const key = level ?? 'unleveled';
    byLevel[key] = (byLevel[key] ?? 0) + 1;
    const known = words.some((w) => knownSet.has(w.id));
    if (known) knownCount++;
    else unknownCount++;
  }

  return { totalTokens: tokens.length, wordTokens, byLevel, knownCount, unknownCount };
}
