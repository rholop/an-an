import { pickDistractors } from '../cloze/distractors.js';
import { selectClozeSource, type ClozeSourceCandidate, type SelectClozeSourceOptions } from '../cloze/source.js';
import type { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { LEECH_TREATMENTS, type LeechTreatment, type SkillCard } from './types.js';

/**
 * Next untried leech treatment for a card already flagged `leech`. Cycles
 * through LEECH_TREATMENTS in order, skipping ones already recorded in
 * leechTreatmentsTried; wraps around (re-offers the first) once all four
 * have been tried at least once. char_breakdown (Phase 2), new_context and
 * contrast_confusable (Phase 4, see below) are real; mnemonic_prompt is
 * still a stub the UI can label "coming soon" — but this still returns
 * whichever treatment is next in rotation so the data model is ready for
 * it too.
 */
export function nextLeechTreatment(card: Pick<SkillCard, 'leechTreatmentsTried'>): LeechTreatment {
  const untried = LEECH_TREATMENTS.find((t) => !card.leechTreatmentsTried.includes(t));
  return untried ?? LEECH_TREATMENTS[card.leechTreatmentsTried.length % LEECH_TREATMENTS.length]!;
}

/**
 * new_context leech treatment (phase doc §7): "pick a sentence not seen
 * before" — the same cloze source priority as a normal review, but
 * excluding sentences already shown for this item, forcing a fresh context
 * the familiar-but-failing association can't just pattern-match against.
 */
export function pickNewContextSentence(
  word: Word,
  opts: SelectClozeSourceOptions,
  previouslyShownZh: ReadonlySet<string>,
): ClozeSourceCandidate | null {
  return selectClozeSource(word, { ...opts, excludeZh: previouslyShownZh });
}

export interface ConfusableContrast {
  target: Word;
  confusable: Word;
}

/**
 * contrast_confusable leech treatment (phase doc §7): "side-by-side MC with
 * the word it's confused with" — reuses the same confusable-ranking
 * distractors.ts already uses for rung-2 multiple choice, just asking for
 * one. Returns null if the lexicon has no eligible confusable at all (e.g.
 * a word alone at its level).
 */
export function pickConfusableContrast(target: Word, lexicon: Lexicon, rng: () => number = Math.random): ConfusableContrast | null {
  const [confusable] = pickDistractors(target, lexicon, { count: 1, preferConfusable: true }, rng);
  return confusable ? { target, confusable } : null;
}
