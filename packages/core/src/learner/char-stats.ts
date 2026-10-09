import type { Lexicon } from '../lexicon.js';

/**
 * Phase 29 Part B.10: the characters the learner knows are the characters of their Learned words
 * (the ledger's `comprehensible().knownIds`), not of any card in any state. Used for pacing: a new
 * word built from familiar characters is easier to absorb.
 */
export function knownCharacters(learnedWordIds: Iterable<string>, lexicon: Pick<Lexicon, 'byId'>): Set<string> {
  const out = new Set<string>();
  for (const id of learnedWordIds) for (const ch of lexicon.byId(id)?.chars ?? []) out.add(ch);
  return out;
}

/** Share of `word`'s characters the learner already knows from other words (1 for none). */
export function transparency(word: { chars: string[] }, known: ReadonlySet<string>): number {
  if (word.chars.length === 0) return 1;
  return word.chars.filter((ch) => known.has(ch)).length / word.chars.length;
}
