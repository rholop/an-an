// Phase 22 Part A: one review status, the same on every screen. Home, Review, Garden and the nav
// all read their numbers from `reviewStatus`; nothing else counts "due" for display (an
// architecture test enforces it). Pure; time is always injected.

import { REVIEW_PILE_CONFIG } from '../learner/review-pile.config.js';
import { isActiveCard } from '../learner/review-pile.js';
import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';
import { isDueCard } from './terms.js';

/** Evidence kinds that are a review answer (they count toward the daily cap). */
export const REVIEW_ANSWER_KINDS: ReadonlySet<string> = new Set([
  'review_again',
  'review_hard',
  'review_good',
  'review_easy',
]);

export type NewState = 'open' | 'reduced' | 'paused_backlog' | 'limit_reached';

export interface ReviewStatus {
  /** Cards due now (answered at least once, not removed by Nope). The only number called "due". */
  dueNow: number;
  /** Cards that become due later today (after now, before local midnight). */
  laterToday: number;
  /** When the next of those falls due (undefined when none is left today). */
  nextDueAt?: Date;
  /** Distinct cards answered in Review today: an Again repeat counts once. */
  doneToday: number;
  cap: number;
  /** Reviews left under the daily cap today. */
  capLeft: number;
  /** "Review all (N)": the cards due now that fit under the cap. */
  reviewAll: number;
  /** "Water all (N)": distinct words with a card due now (the garden's "needs water"). */
  thirstyWords: number;
  /** Word ids behind `thirstyWords`. */
  thirstyWordIds: string[];
  /** New words today. */
  newState: NewState;
  /** The line shown for `newState` (absent while new words are open). */
  newMessage?: string;
  /** How many new items a session may add. */
  newAllowed: number;
}

/** The one wording for each new-word state (Home and Review show the same line). */
export function newStateMessage(state: NewState, cap: number): string | undefined {
  switch (state) {
    case 'paused_backlog':
      return 'New words paused until your reviews catch up.';
    case 'limit_reached':
      return `You've done today's ${cap} reviews. New words return tomorrow.`;
    case 'reduced':
      return 'Fewer new words today while reviews catch up.';
    default:
      return undefined;
  }
}

/** New words today, from how many cards are due now and what's left under the cap. The one rule
 * every session (Review, Cloze, lesson study) and every screen uses. */
export function newWordState(input: {
  dueNow: number;
  capLeft: number;
  cap?: number;
  baseNew: number;
  newHalfShare?: number;
}): { newState: NewState; newAllowed: number; newMessage?: string } {
  const cap = input.cap ?? REVIEW_PILE_CONFIG.dailyCap;
  const half = input.newHalfShare ?? REVIEW_PILE_CONFIG.newHalfShare;
  let newState: NewState = 'open';
  let newAllowed = input.baseNew;
  if (input.capLeft <= 0) {
    newState = 'limit_reached';
    newAllowed = 0;
  } else if (input.dueNow > cap) {
    // Behind: more due right now than a whole day's cap.
    newState = 'paused_backlog';
    newAllowed = 0;
  } else if (input.dueNow > cap * half) {
    newState = 'reduced';
    newAllowed = Math.floor(input.baseNew / 2);
  }
  const newMessage = newStateMessage(newState, cap);
  return { newState, newAllowed, ...(newMessage ? { newMessage } : {}) };
}

/** Local midnight after `now` (the end of "today"). */
export function endOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

const cardKey = (c: Pick<SkillCard, 'item' | 'skill'>) => `${c.item.kind}:${c.item.id}|${c.skill}`;

/** Distinct cards answered in Review today (from already-active evidence: undone answers removed). */
export function distinctReviewedToday(
  evidence: readonly Pick<Evidence, 'item' | 'skill' | 'kind' | 'at'>[],
  now: Date,
): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const seen = new Set<string>();
  for (const e of evidence) {
    if (!REVIEW_ANSWER_KINDS.has(e.kind)) continue;
    const t = e.at.getTime();
    if (t < start.getTime() || t > now.getTime()) continue;
    seen.add(cardKey(e));
  }
  return seen.size;
}

/**
 * Part A: due now, later today, done today, what's left under the cap and what new words may do.
 * `cards` is every card (listening cards are ignored: they are their own queue).
 */
export function reviewStatus(input: {
  cards: readonly SkillCard[];
  /** Today's evidence with undone answers already removed (`activeEvidence`). */
  evidence: readonly Pick<Evidence, 'item' | 'skill' | 'kind' | 'at'>[];
  now: Date;
  cap?: number;
  /** New items a session adds when nothing holds them back. */
  baseNew?: number;
  newHalfShare?: number;
}): ReviewStatus {
  const { now } = input;
  const cap = input.cap ?? REVIEW_PILE_CONFIG.dailyCap;
  const baseNew = input.baseNew ?? 0;
  const half = input.newHalfShare ?? REVIEW_PILE_CONFIG.newHalfShare;
  const midnight = endOfDay(now).getTime();
  let dueNow = 0;
  let laterToday = 0;
  let nextDue: number | undefined;
  const thirsty = new Set<string>();
  for (const c of input.cards) {
    if (c.skill === 'listening') continue;
    if (isDueCard(c, now)) {
      dueNow++;
      if (c.item.kind === 'word') thirsty.add(c.item.id);
      continue;
    }
    if (c.state === 'unseen' || c.card.reps === 0 || !isActiveCard(c)) continue;
    const t = c.card.due.getTime();
    if (t > now.getTime() && t < midnight) {
      laterToday++;
      if (nextDue === undefined || t < nextDue) nextDue = t;
    }
  }
  const doneToday = distinctReviewedToday(input.evidence, now);
  const capLeft = Math.max(0, cap - doneToday);
  const n = newWordState({ dueNow, capLeft, cap, baseNew, newHalfShare: half });
  return {
    dueNow,
    laterToday,
    ...(nextDue !== undefined ? { nextDueAt: new Date(nextDue) } : {}),
    doneToday,
    cap,
    capLeft,
    reviewAll: Math.min(dueNow, capLeft),
    thirstyWords: thirsty.size,
    thirstyWordIds: [...thirsty],
    ...n,
  };
}

/**
 * The forecast bars: [rest of today (after now, excluding cards due now), tomorrow, …], `days`
 * entries in all. Cards due now have their own number (`dueNow`), never a bar.
 */
export function reviewForecast(cards: readonly SkillCard[], now: Date, days = 7): number[] {
  const starts: number[] = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    starts.push(d.getTime());
  }
  const out = new Array<number>(days).fill(0);
  for (const c of cards) {
    if (c.skill === 'listening' || c.state === 'unseen' || c.card.reps === 0 || !isActiveCard(c))
      continue;
    const t = c.card.due.getTime();
    if (t <= now.getTime()) continue; // due now
    for (let i = 0; i < days; i++) {
      if (t >= starts[i]! && t < starts[i + 1]!) {
        out[i]!++;
        break;
      }
    }
  }
  return out;
}
