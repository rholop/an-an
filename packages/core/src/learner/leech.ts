import { LEECH_TREATMENTS, type LeechTreatment, type SkillCard } from './types.js';

/**
 * Next untried leech treatment for a card already flagged `leech`. Cycles
 * through LEECH_TREATMENTS in order, skipping ones already recorded in
 * leechTreatmentsTried; wraps around (re-offers the first) once all four
 * have been tried at least once. Phase 2 only actually *implements*
 * char_breakdown in the review screen — the other three are stubs the UI
 * labels as "coming soon" — but this still returns whichever treatment is
 * next in rotation so the data model is ready for them.
 */
export function nextLeechTreatment(card: Pick<SkillCard, 'leechTreatmentsTried'>): LeechTreatment {
  const untried = LEECH_TREATMENTS.find((t) => !card.leechTreatmentsTried.includes(t));
  return untried ?? LEECH_TREATMENTS[card.leechTreatmentsTried.length % LEECH_TREATMENTS.length]!;
}
