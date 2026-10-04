// Phase 14: how a review session uses the study order. Due cards are never dropped,
// only ordered (textbook first); new items come only from the active step, in book order.
import { PRIORITY_CONFIG } from '../curriculum/priority.config.js';
import type { ItemRef } from '../types.js';
import { orderDueCards, type StudyFocus } from './study-focus.js';

export interface ReviewPlan<T> {
  ordered: T[];
  /** Items to introduce in this session (no card yet), in introduction order. */
  newItems: ItemRef[];
}

/**
 * `due` should already be shuffled (as before Phase 14): ordering is a STABLE sort by rank, so
 * the shuffle still mixes cards inside a rank. With the study order off the plan is the input,
 * unchanged, and nothing new is introduced — exactly the pre-Phase-14 session.
 */
export function planReviewSession<T extends { item: ItemRef }>(
  due: readonly T[],
  focus: StudyFocus | undefined,
  lessonIdx: ReadonlyMap<string, string>,
  maxNew: number = PRIORITY_CONFIG.reviewNewItems,
): ReviewPlan<T> {
  if (!focus || !focus.enabled) return { ordered: [...due], newItems: [] };
  return {
    ordered: orderDueCards(due, focus, lessonIdx),
    newItems: focus.newItemsAllowed.slice(0, Math.max(0, maxNew)),
  };
}

/** Words a chat turn / journal prompt should target: unmastered active-lesson items, then review lessons'. */
export function studyTargetWordIds(focus: StudyFocus | undefined, n: number): string[] {
  if (!focus || !focus.enabled) return [];
  const ids = [...focus.focusItems, ...focus.reviewItems].filter((i) => i.kind === 'word').map((i) => i.id);
  return [...new Set(ids)].slice(0, n);
}

/** The grammar point to hint at: first unmastered one of the active lesson, else a review lesson's. */
export function studyGrammarId(focus: StudyFocus | undefined): string | undefined {
  if (!focus || !focus.enabled) return undefined;
  return [...focus.focusItems, ...focus.reviewItems].find((i) => i.kind === 'grammar')?.id;
}
