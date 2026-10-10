import { PROGRESS_CONFIG } from '../progress/progress.config.js';
import { DEFAULT_CLASS_AHEAD_LESSONS } from '../textbook/scope.js';

/**
 * Phase 14 "one study order": how far ahead of class the app may go and how new items are
 * mixed in. Since Phase 21 the mastery thresholds themselves live in `progress.config.ts`
 * (one set of definitions for every tab); they are re-exported here for the study order.
 */
export const PRIORITY_CONFIG = {
  mastery: {
    recognitionStabilityDays: PROGRESS_CONFIG.mastered.recognitionStabilityDays,
    productionStabilityDays: PROGRESS_CONFIG.mastered.productionStabilityDays,
    grammarCorrectUses: PROGRESS_CONFIG.mastered.grammarCorrectUses,
    lessonShare: PROGRESS_CONFIG.mastered.lessonShare,
    levelShare: PROGRESS_CONFIG.mastered.levelShare,
  },
  /** How many lessons past the class position the active lesson may run (preview). */
  classAheadLessons: DEFAULT_CLASS_AHEAD_LESSONS,
  /** Share of a batch of new items that may come from beyond the active step. 0 = none. */
  aheadShare: 0,
  /** New items a review session introduces from the active step. */
  reviewNewItems: 5,
  /** Reader: share of sentences built around a weak item of a review lesson instead. */
  reviewLessonShare: 0.3,
  /**
   * Phase 34: do a lesson's extra words (補充生詞 + words from its other pages) count toward the
   * lesson's Mastered share and the gate? false = only the book's own 生詞 list does.
   */
  extrasCountForLessonMastery: false as boolean,
  /** Evidence kinds that count as a correct / incorrect use of a grammar point. */
  grammarCorrectKinds: PROGRESS_CONFIG.grammarCorrectKinds,
  grammarWrongKinds: PROGRESS_CONFIG.grammarWrongKinds,
} as const;

export type PriorityConfig = typeof PRIORITY_CONFIG;
