// Phase 45 "Practise these words" (owner, 2026-10-17: "Why won't it count towards mastered?"): a
// lesson's or a tutoring class's words can be practised any time. A card's first practice answer of
// the profile-zone day is a real review (FSRS, Easy count, Good run); later answers that day are
// `practice_*` and change nothing but Again's priority. The ledger decides which (`practiceCounts`).

import type { Evidence } from '../types.js';

export type PracticeGrade = 'again' | 'hard' | 'good' | 'easy';

/** Cards in one practice round (then "Practise another round" / "Done"). */
export const PRACTICE_ROUND_SIZE = 20;

/** The evidence kind of a practice answer: a review when it counts, else practice only. */
export function practiceAnswerKind(grade: PracticeGrade, counts: boolean): Evidence['kind'] {
  return counts ? `review_${grade}` : `practice_${grade}`;
}

/** A practice-only answer (no FSRS, no counts). */
export const isPracticeOnlyKind = (kind: string): boolean => kind.startsWith('practice_');
