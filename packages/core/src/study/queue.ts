// Phase 14: how a review session uses the study order. Due cards are never dropped,
// only ordered (textbook first); new items come only from the active step, in book order.
import { PRIORITY_CONFIG } from '../curriculum/priority.config.js';
import type { ItemRef } from '../types.js';
import { orderDueCards, studyRank, type StudyFocus } from './study-focus.js';
import type { SkillCard } from '../learner/types.js';
import { isNewCard } from '../progress/terms.js';

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

/**
 * Phase 21 Part F: the ONE "new" rule every session builder uses (Review, Cloze, Listen, the lesson
 * step). New = cards introduced but never answered (`isNewCard`: My class coverage, lookups,
 * production unlocks) plus study-order items with no card yet. At most `allowed` of them (the
 * Phase 20 allowance), study-order rank first; `onlyItems` limits them to one lesson.
 */
export function pickNewForSession<T extends SkillCard>(input: {
  newCards: readonly T[];
  focus?: StudyFocus;
  lessonIdx?: ReadonlyMap<string, string>;
  allowed: number;
  /** Item keys ("word:id") to keep (e.g. one lesson's items). */
  onlyItems?: ReadonlySet<string>;
  /** Extra items with no card to introduce after the focus's (e.g. a lesson's own new items). */
  extraItems?: readonly ItemRef[];
  /** Phase 23: New production / reading cards (new faces of words already being learned) get
   * their own allowance instead of using the new-word one. Absent = they share `allowed`. */
  allowedFaces?: number;
}): { cards: T[]; items: ItemRef[] } {
  if (input.allowedFaces !== undefined) {
    const isFace = (c: T) => c.skill === 'production' || c.skill === 'reading';
    const { allowedFaces, ...rest } = input;
    const words = pickNewForSession({ ...rest, newCards: input.newCards.filter((c) => !isFace(c)) });
    const faces = pickNewForSession({
      ...rest,
      newCards: input.newCards.filter(isFace),
      allowed: allowedFaces,
      extraItems: [],
      ...(rest.focus ? { focus: { ...rest.focus, newItemsAllowed: [] } } : {}),
    });
    return { cards: [...words.cards, ...faces.cards], items: words.items };
  }
  const n = Math.max(0, Math.floor(input.allowed));
  if (n === 0) return { cards: [], items: [] };
  const key = (i: ItemRef) => `${i.kind}:${i.id}`;
  const keep = (i: ItemRef) => !input.onlyItems || input.onlyItems.has(key(i));
  const focus = input.focus?.enabled ? input.focus : undefined;
  const idx = input.lessonIdx;
  const rank = (i: ItemRef) => (focus && idx ? studyRank(focus, (x) => idx.get(key(x)), i) : 0);
  const cards = input.newCards
    .filter((c) => isNewCard(c) && keep(c.item))
    .map((c, i) => ({ c, i, r: rank(c.item) + (c.skill === 'production' ? 0.5 : 0) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
    .slice(0, n);
  const carded = new Set(input.newCards.map((c) => key(c.item)));
  const seen = new Set<string>();
  const items: ItemRef[] = [];
  for (const i of [...(focus?.newItemsAllowed ?? []), ...(input.extraItems ?? [])]) {
    if (cards.length + items.length >= n) break;
    const k = key(i);
    if (carded.has(k) || seen.has(k) || !keep(i)) continue;
    seen.add(k);
    items.push(i);
  }
  return { cards, items };
}
