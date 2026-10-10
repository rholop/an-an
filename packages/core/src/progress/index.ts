// Phase 29 Part A.4: the public face of `core/progress`. Progress numbers and decisions come from
// the ledger (`buildLedger`); the low-level predicates it is built from (isDueCard, isDueBefore,
// isNewCard, isScheduledCard, isDueListening, ProgressIndex, newWordState, sessionCards,
// sessionWindows, sessionAt, reviewStatus, wordSets …) are deliberately NOT exported, so code
// outside `core/progress` cannot combine them its own way. `apps/web/src/__type-fixtures__`
// holds a file that must fail to import them (the type check fails if one is exported again).

export { PROGRESS_CONFIG, type ProgressConfig } from './progress.config.js';
export * from './ledger.js';

// Settings, sessions and days (the sanctioned helpers; no counting here).
export {
  DEFAULT_SESSION_SETTINGS,
  isValidTimeZone,
  sanitizeSessionSettings,
  type SessionName,
  type SessionSettings,
  type SessionWindow,
} from './review-sessions.js';
export {
  addDaysToKey,
  dayKey,
  daysBetweenKeys,
  weekRange,
  zonedDay,
  zonedParts,
  type WeekRange,
  type ZonedParts,
} from './time.js';
export {
  newStateMessage,
  REVIEW_ANSWER_KINDS,
  sessionCardKey,
  type ForecastDay,
  type NewState,
  type ReviewStatus,
  type SessionState,
} from './review-status.js';

// Definitions that are not counts: item keys, item sets, skills, grammar wording, unlocks (written by
// the scheduler's persistence), comprehension classes.
export {
  ALWAYS_ALLOWED_TAGS,
  COMPREHENSIBLE_CLASSES,
  grammarDots,
  grammarOutcome,
  isActiveCard,
  isAlwaysAllowedWord,
  isPracticeSkill,
  isReviewSkill,
  itemKeyOf,
  lessonCoreItems,
  lessonCoreWordIds,
  levelItems,
  productionUnlockFor,
  readingUnlockFor,
  type GrammarUse,
  type ItemProgress,
  type LearnedMastered,
  type WordSets,
} from './terms.js';

// Phase 27: learning steps finish in the sitting (one rule for every flashcard sitting).
export {
  inShortStep,
  parkShortStep,
  requeueInSitting,
  stepInSitting,
  SITTING_CONFIG,
  type SittingConfig,
} from './sitting.js';

export {
  bestRung,
  lessonsInCourseOrder,
  VOCAB_LADDER_DEFAULTS,
  type LadderLesson,
  type LadderSource,
  type VocabLadder,
  type VocabLadderOptions,
  type VocabRung,
} from './vocabLadder.js';

// Phase 32: the active days behind the streak (what counts, the one-time back-fill, the sync merge).
export {
  ACTIVITY_EVIDENCE_KINDS,
  activeDaysFromHistory,
  countsAsActivity,
  mergeActiveDays,
  type ActiveDay,
  type ActivityHistory,
} from './active-days.js';

export { summarizeSavedCopy, type SavedCopySummary } from './saved-copy.js';
