import type { Lexicon } from '../lexicon.js';
import type { SkillCard } from './types.js';

/** Per-character derived strength = max (or mean) FSRS stability among known
 * words containing that character, across all their SkillCards. Used for
 * pacing (transparency of new words) — phase doc §1 "Character stats". */
export type CharStats = Map<string, { max: number; mean: number; sampleCount: number }>;

export function computeCharStats(cards: SkillCard[], lexicon: Lexicon): CharStats {
  const perChar = new Map<string, number[]>();

  for (const sc of cards) {
    if (sc.item.kind !== 'word') continue;
    const word = lexicon.byId(sc.item.id);
    if (!word) continue;
    for (const ch of word.chars) {
      const list = perChar.get(ch);
      if (list) list.push(sc.card.stability);
      else perChar.set(ch, [sc.card.stability]);
    }
  }

  const stats: CharStats = new Map();
  for (const [ch, values] of perChar) {
    const max = Math.max(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    stats.set(ch, { max, mean, sampleCount: values.length });
  }
  return stats;
}

/** Share of `word`'s characters that are already "strong" (appear in
 * charStats at all, i.e. known via some other word) — used for pacing: a
 * new word built entirely from familiar characters is easier to absorb. */
export function transparency(word: { chars: string[] }, charStats: CharStats): number {
  if (word.chars.length === 0) return 1;
  const known = word.chars.filter((ch) => charStats.has(ch)).length;
  return known / word.chars.length;
}
