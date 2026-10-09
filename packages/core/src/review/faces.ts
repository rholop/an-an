// Phase 23 Part B: the faces a Review card can show, the production ladder (Pick → Recall) and the
// per-session mix of skills. Pure; time is always injected.

import type { SkillCard } from '../learner/types.js';
import { capDueCards } from '../learner/review-pile.js';
import type { Skill } from '../types.js';
import { startsAtRecall } from '../progress/terms.js';
import { PROGRESS_CONFIG } from '../progress/progress.config.js';

export type ReviewFace = 'meaning' | 'pick' | 'recall' | 'say' | 'grammar';

export interface ReviewFaceConfig {
  /** Shares of a capped session per skill (recognition = Meaning, production = Pick/Recall,
   * reading = Say it). Renormalised over the skills that have due cards. */
  shares: Record<'recognition' | 'production' | 'reading', number>;
  /** Correct picks in a row that move production from Pick to Recall. */
  pickToRecall: number;
  /** New production / reading cards of words already being learned that may join one session
   * (on top of the new-word allowance; never in a backlog, halved while one builds). */
  newFacesPerSession: number;
}

export const REVIEW_FACE_CONFIG: ReviewFaceConfig = {
  shares: { recognition: 0.4, production: 0.4, reading: 0.2 },
  pickToRecall: 2,
  newFacesPerSession: PROGRESS_CONFIG.newFacesPerSession,
};

/** Where a production card is on the ladder. */
export function productionRung(c: Pick<SkillCard, 'prodRung' | 'state' | 'card'>): 'pick' | 'recall' {
  if (c.prodRung) return c.prodRung;
  return startsAtRecall(c) ? 'recall' : 'pick';
}

/** The face a card shows in Review. */
export function reviewFace(c: Pick<SkillCard, 'item' | 'skill' | 'prodRung' | 'state' | 'card'>): ReviewFace {
  if (c.item.kind === 'grammar') return 'grammar';
  if (c.skill === 'production') return productionRung(c) === 'pick' ? 'pick' : 'recall';
  if (c.skill === 'reading') return 'say';
  return 'meaning';
}

/**
 * The ladder after an answer on a production face: 2 correct picks in a row move it to Recall; a
 * wrong pick resets the streak; a lapse at Recall moves it back to Pick (Phase 4's ladder idea).
 */
export function nextProductionRung(
  current: Pick<SkillCard, 'prodRung' | 'prodStreak' | 'state' | 'card'>,
  face: 'pick' | 'recall',
  correct: boolean,
  cfg: ReviewFaceConfig = REVIEW_FACE_CONFIG,
): { prodRung: 'pick' | 'recall'; prodStreak: number } {
  if (face === 'recall') return correct ? { prodRung: 'recall', prodStreak: 0 } : { prodRung: 'pick', prodStreak: 0 };
  if (!correct) return { prodRung: 'pick', prodStreak: 0 };
  const streak = (current.prodRung === 'pick' || !current.prodRung ? (current.prodStreak ?? 0) : 0) + 1;
  return streak >= cfg.pickToRecall ? { prodRung: 'recall', prodStreak: 0 } : { prodRung: 'pick', prodStreak: streak };
}

type MixSkill = 'recognition' | 'production' | 'reading';
const mixSkill = (s: Skill): MixSkill => (s === 'production' ? 'production' : s === 'reading' ? 'reading' : 'recognition');

/**
 * At most `remaining` of the session's cards, mixed by skill in the configured shares (about 40%
 * meaning, 40% production, 20% reading). Inside each skill the most important go first (study
 * order, then the most likely forgotten, as `capDueCards`); room a skill can't use goes to the others.
 */
export function capMixedCards<T extends SkillCard>(
  due: readonly T[],
  opts: { remaining: number; now: Date; rank?: (c: T) => number; shares?: ReviewFaceConfig['shares'] },
): T[] {
  const n = Math.max(0, Math.floor(opts.remaining));
  if (due.length <= n) return [...due];
  const shares = opts.shares ?? REVIEW_FACE_CONFIG.shares;
  const groups = new Map<MixSkill, T[]>();
  for (const c of due) {
    const k = mixSkill(c.skill);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const total = [...groups.keys()].reduce((a, k) => a + shares[k], 0) || 1;
  const picked = new Set<T>();
  for (const [k, cards] of groups) {
    const quota = Math.floor((n * shares[k]) / total);
    for (const c of capDueCards(cards, { remaining: quota, now: opts.now, ...(opts.rank ? { rank: opts.rank } : {}) }))
      picked.add(c);
  }
  const rest = due.filter((c) => !picked.has(c));
  for (const c of capDueCards(rest, { remaining: n - picked.size, now: opts.now, ...(opts.rank ? { rank: opts.rank } : {}) }))
    picked.add(c);
  // keep the caller's order
  return due.filter((c) => picked.has(c));
}
