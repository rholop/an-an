// Phase 27: learning steps finish where they start. FSRS keeps a new or lapsed card in short steps
// (1 and 10 minutes). Inside a sitting (lesson study, Review, Water all, Cloze, every flashcard
// session) a step due within `stepWithinMinutes` comes back later in the same sitting, until FSRS
// moves the card out of the short step. The stored due time of a card still in a short step is the
// start of the next review session, so a learner who leaves early never has a card fall due at a
// stray time minutes later (the garden would turn thirsty between sessions). Pure; time is injected.

import { State } from 'ts-fsrs';
import { PROGRESS_CONFIG } from './progress.config.js';
import type { SkillCard } from '../learner/types.js';
import { DEFAULT_SESSION_SETTINGS, sessionAt, type SessionSettings } from './review-sessions.js';
import { SESSION_ORDER_DEFAULTS, requeueAgain, type OrderSessionOptions, type SessionCard } from '../session/orderSession.js';

export const SITTING_CONFIG = {
  /** A step due within this many minutes of the answer comes back in the same sitting. */
  stepWithinMinutes: PROGRESS_CONFIG.sittingStepMinutes,
} as const;

export type SittingConfig = { stepWithinMinutes: number };

const time = (d: Date | string) => new Date(d).getTime();

/** FSRS is still drilling the card in its short steps (first answers, or after a lapse). */
export function inShortStep(c: Pick<SkillCard, 'card'>): boolean {
  return c.card.state === State.Learning || c.card.state === State.Relearning;
}

/** When the card's short step is really due (before `parkShortStep` moved it). */
export function stepDueOf(c: Pick<SkillCard, 'card' | 'stepDue'>): Date {
  return new Date(c.stepDue ?? c.card.due);
}

/** Does this answered card come back later in the sitting? Yes while it is in a short step that is
 * due within the sitting window. */
export function stepInSitting(
  c: Pick<SkillCard, 'card' | 'stepDue'> | undefined,
  now: Date,
  cfg: SittingConfig = SITTING_CONFIG,
): boolean {
  if (!c || !inShortStep(c)) return false;
  return time(stepDueOf(c)) - now.getTime() <= cfg.stepWithinMinutes * 60_000;
}

/**
 * The card as stored after an answer: still in a short step and due later than now but before the
 * next review session opens, it is due at that session's start instead (the step's own time is kept in `stepDue` for the
 * sitting). Any other card is returned without `stepDue`.
 */
export function parkShortStep(c: SkillCard, now: Date, settings: SessionSettings = DEFAULT_SESSION_SETTINGS): SkillCard {
  if (!inShortStep(c)) {
    if (c.stepDue === undefined) return c;
    const { stepDue: _s, ...rest } = c;
    return rest;
  }
  const opensAt = sessionAt(now, settings).next.opensAt;
  // Already due (an old card, or one touched without an answer) stays where it is: it is in a session.
  if (time(c.card.due) <= now.getTime() || time(c.card.due) >= opensAt.getTime()) return c;
  return { ...c, stepDue: new Date(c.card.due), card: { ...c.card, due: opensAt } };
}

/**
 * Put the card at `at` back later in the queue: at least `minSiblingGap` cards on and away from its
 * siblings when the queue allows (Phase 19 rule 6), otherwise as far from its siblings as the rest of
 * the queue allows (the end of a short queue), so the step always finishes in the sitting.
 * `replace` is the answered card as it is now (the queue shows the up-to-date card next time).
 */
export function requeueInSitting<T>(
  queue: readonly T[],
  at: number,
  describe: (card: T) => SessionCard,
  opts: Pick<OrderSessionOptions, 'minSiblingGap'> & { replace?: T } = {},
): T[] {
  const card = queue[at];
  if (card === undefined) return [...queue];
  const base = opts.replace === undefined ? [...queue] : queue.map((c, i) => (i === at ? opts.replace! : c));
  const spaced = requeueAgain(base, at, describe, opts);
  if (spaced.length !== base.length) return spaced;
  const gap = opts.minSiblingGap ?? SESSION_ORDER_DEFAULTS.minSiblingGap;
  const keys = describe(base[at]!).keys;
  const sib = (j: number) => j !== at && describe(base[j]!).keys.some((k) => keys.includes(k));
  // Inserting at p puts the card between base[p-1] and base[p]; score = distance to the nearest sibling.
  let best = base.length;
  let bestScore = -1;
  for (let p = at + 1; p <= base.length; p++) {
    let score = Math.min(gap + 1, p - at);
    for (let j = at + 1; j < base.length; j++) if (sib(j)) score = Math.min(score, j < p ? p - j : j - p + 1);
    if (score >= bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return [...base.slice(0, best), base[at]!, ...base.slice(best)];
}
