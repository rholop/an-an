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
    /** Phase 42: Easy ratings every mastery card needs for a word to be Mastered. */
    easyRatings: 3,
    /** Phase 42: days after earning them that each such card comes back once to be re-checked. */
    recheckDays: 14,
    /** Phase 42: the cards a word's Mastered counts (Say it stays practice, Phase 23). */
    faces: ['recognition', 'production'] as const,
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
  /** Phase 29 (was a literal in review/faces.ts): a production card this stable (days) in review
   * moves from Pick the Mandarin to Recall. */
  recallStabilityDays: 7,
  /** Phase 29 Part B.4: the practice queues' own limits on new items in one session (Phase 43: Review
   * has no per-session number any more; it takes its share of the day's `newPerDay`, and Cloze is
   * also held to what is left of that). */
  newPerQueue: { cloze: 5, pinyin: 10, listening: 4 },
  /** Phase 43 Part A (owner, 2026-10-16: "15 new words plus up to 25 new card types a day"): first-time
   * cards per session day (the day the morning session opens). `words` = a word's first card
   * (Meaning) or a grammar point's; `faces` = a later face (Pick, Say it) entering for the first time.
   * Per profile in Settings → Review (`SessionSettings.newWordsPerDay` / `newFacesPerDay`). */
  newPerDay: { words: 15, faces: 25 },
  /** Share of the session cap above which new items are halved (practice queues). */
  newHalfShare: 0.5,
  /** Phase 43 Part A.4: at most this share of each daily limit in the morning session (rounded up). */
  morningNewShare: 0.5,
  /** Phase 43 Part B.2 (owner: "2"): Good/Easy answers in a row, each in a different review session,
   * that release a word's next face. Again or Hard resets the run. */
  faceReleaseGoodRuns: 2,
  /** Phase 43 Part E: an Again card comes back at least this many cards later (or last in its block). */
  againGap: 10,
  /** Phase 43 Part E.2: the Again that puts a card aside until the next session (counted per session). */
  againsBeforePark: 3,
  /** Phase 29 Part B.3: a card whose next learning step is due within this many minutes comes back
   * in the same sitting (Review, lesson study, Water all, Cloze). */
  sittingStepMinutes: 20,
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
