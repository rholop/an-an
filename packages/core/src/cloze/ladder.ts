import type { ClozeRung } from '../learner/types.js';

/** Phase 4 §3's three graded outcomes for a cloze answer:
 * - 'correct': right answer, no hint needed.
 * - 'correct_wrong_tone': right word, wrong (or unspecified) tone — a
 *   hint-equivalent partial credit (see cloze/grading.ts), evidence kind
 *   `cloze_correct_hint`.
 * - 'wrong': evidence kind `cloze_wrong`.
 */
export type ClozeOutcome = 'correct' | 'correct_wrong_tone' | 'wrong';

export interface LadderState {
  rung: ClozeRung;
  streak: number;
}

const MIN_RUNG: ClozeRung = 1;
const MAX_RUNG: ClozeRung = 3;

/** Consecutive no-hint-correct answers at a rung required to promote
 * (phase doc §3: "Promote after 2 consecutive correct at a rung with no
 * hint"). */
const PROMOTE_STREAK = 2;

/**
 * Pure difficulty-ladder transition (phase doc §3). A hint (wrong tone)
 * doesn't demote — it just isn't "no hint", so it resets the promotion
 * streak without punishing the rung itself. A genuine miss demotes one
 * rung (floor at 1) and resets the streak. Two consecutive no-hint
 * corrects promote one rung (capped at 3) and reset the streak.
 */
export function nextLadderState(current: LadderState, outcome: ClozeOutcome): LadderState {
  if (outcome === 'wrong') {
    return { rung: Math.max(MIN_RUNG, current.rung - 1) as ClozeRung, streak: 0 };
  }
  if (outcome === 'correct_wrong_tone') {
    return { rung: current.rung, streak: 0 };
  }

  const streak = current.streak + 1;
  if (streak >= PROMOTE_STREAK) {
    return { rung: Math.min(MAX_RUNG, current.rung + 1) as ClozeRung, streak: 0 };
  }
  return { rung: current.rung, streak };
}
