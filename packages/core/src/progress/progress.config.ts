/**
 * Phase 21: every threshold that decides New / Due / Learned / Mastered, and the other
 * "how strong is this card" questions (pinyin fading, garden stages, listening strength),
 * lives here and nowhere else. An architecture test fails if another file compares a
 * card's stability or state to a literal.
 */
export const PROGRESS_CONFIG = {
  /** FSRS stability (days) at which a card's ItemState becomes 'mature'. */
  matureStabilityDays: 21,
  mastered: {
    /** Recognition stability (days) a mastered word needs ("you'd still remember it in about 3 weeks"). */
    recognitionStabilityDays: 21,
    /** Production stability (days) a mastered word needs ("and can produce it from English"). */
    productionStabilityDays: 7,
    /** A grammar point: correct uses needed, with the most recent use correct. */
    grammarCorrectUses: 3,
    /** Share of a lesson's items mastered for the lesson to count as mastered. */
    lessonShare: 0.9,
    /** Share of a TOCFL level's words mastered for the level (the study-order gate). */
    levelShare: 0.9,
  },
  /** Level-up prompt ("Ready to try L2?"): share of the level's TOCFL words Learned. */
  levelUpLearnedShare: 0.7,
  /** Listening: a listening card this stable (days) is "strong". */
  listeningStrongDays: 7,
  /** Pinyin fading: a recognition card this stable may show its reading on hover only... */
  readingFadeStabilityDays: 21,
  /** ...unless the learner keeps peeking at the reading (readingDependence at or above this). */
  readingFadeMaxDependence: 0.5,
  /** "I already know this" (quick check) and Nope "I know this": stability given (days). */
  knownStabilityDays: 60,
  /** Legacy "already known" list: contradicted by a lapse that left stability below this (days). */
  knownContradictedStabilityDays: 1,
  /** Evidence kinds that count as a correct / wrong use of a grammar point. */
  grammarCorrectKinds: ['cloze_correct_nohint', 'journal_correct_use', 'review_good', 'review_easy'],
  grammarWrongKinds: ['cloze_wrong', 'journal_misuse', 'review_again'],
} as const;

export type ProgressConfig = typeof PROGRESS_CONFIG;
