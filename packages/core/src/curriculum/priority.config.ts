/**
 * Phase 14 "one study order": every number that decides what is mastered, what is
 * active and how far ahead of class the app may go lives here, and nowhere else.
 */
export const PRIORITY_CONFIG = {
  mastery: {
    /** Recognition stability (FSRS, days) an item needs. */
    recognitionStabilityDays: 21,
    /** Production stability (FSRS, days) an item needs. */
    productionStabilityDays: 7,
    /** A grammar point: correct uses needed, with the most recent use correct. */
    grammarCorrectUses: 3,
    /** Share of a lesson's items that must be mastered for the lesson. */
    lessonShare: 0.9,
    /** Share of a TOCFL level's words that must be mastered for the level. */
    levelShare: 0.9,
  },
  /** How many lessons past the class position the active lesson may run (preview). */
  classAheadLessons: 1,
  /** Share of a batch of new items that may come from beyond the active step. 0 = none. */
  aheadShare: 0,
  /** Reader: share of sentences built around a weak item of a review lesson instead. */
  reviewLessonShare: 0.3,
  /** Evidence kinds that count as a correct / incorrect use of a grammar point. */
  grammarCorrectKinds: ['cloze_correct_nohint', 'journal_correct_use'],
  grammarWrongKinds: ['cloze_wrong', 'journal_misuse'],
} as const;

export type PriorityConfig = typeof PRIORITY_CONFIG;
