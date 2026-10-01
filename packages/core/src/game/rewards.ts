import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';

/**
 * Phase 6 §1: points are earned only by learning behaviours. Everything the
 * game can ever award is a row in REWARD_TABLE — there is deliberately no
 * kind for time spent, opening the app, or a login streak, and the test suite
 * pins that (rewards.test.ts).
 */
export type RewardKind =
  | 'recall_correct'
  | 'recall_hinted'
  | 'word_revived'
  | 'scenario_completed'
  | 'scenario_unassisted'
  | 'journal_entry'
  | 'self_correction'
  | 'error_fixed';

export interface RewardRule {
  points: number;
  /** One line shown in the points breakdown. */
  label: string;
  /** The learning behaviour being rewarded (documentation + tests). */
  behaviour: string;
}

export const REWARD_TABLE: Record<RewardKind, RewardRule> = {
  recall_correct: {
    points: 2,
    label: 'Recalled a word',
    behaviour: 'successful recall without a hint',
  },
  recall_hinted: {
    points: 1,
    label: 'Recalled a word with a hint',
    behaviour: 'successful recall with help',
  },
  word_revived: {
    points: 5,
    label: 'Revived an overdue word',
    behaviour: 'recalled a word that had been overdue for a week or more',
  },
  scenario_completed: {
    points: 10,
    label: 'Completed a scenario',
    behaviour: 'finished every goal of a conversation scenario',
  },
  scenario_unassisted: {
    points: 10,
    label: 'Completed a scenario unassisted',
    behaviour: 'finished a scenario without "I\'m stuck" or English fallback',
  },
  journal_entry: {
    points: 8,
    label: 'Wrote a journal entry',
    behaviour: 'finished a journal entry',
  },
  self_correction: {
    points: 4,
    label: 'Fixed your own mistake',
    behaviour: 'corrected a flagged journal span yourself',
  },
  error_fixed: {
    points: 3,
    label: 'Fixed an old mistake',
    behaviour: 'answered an error-bank sentence correctly',
  },
};

export interface RewardConfig {
  table: Record<RewardKind, RewardRule>;
  /** A recalled word counts as "revived" when it was overdue at least this long. */
  reviveOverdueDays: number;
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = { table: REWARD_TABLE, reviveOverdueDays: 7 };

export interface RewardEvent {
  /** Deterministic: the same behaviour on the same day is only ever paid once. */
  id: string;
  kind: RewardKind;
  points: number;
  at: Date;
  /** What it was for (item id, conversation id, journal entry id …). */
  refId?: string;
}

const DAY_MS = 86_400_000;

/** Local calendar day, "YYYY-MM-DD". */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function makeReward(
  kind: RewardKind,
  at: Date,
  refId: string,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): RewardEvent {
  return {
    id: `${kind}:${refId}:${dayKey(at)}`,
    kind,
    points: config.table[kind].points,
    at,
    refId,
  };
}

/**
 * Evidence -> rewards. Only graded recall outcomes pay. Weak signals (reading
 * a chat line, hovering, lookups), imports and placement are ignored, and an
 * "Again"/wrong answer earns nothing (and costs nothing). `prior` is the card
 * as it was *before* this evidence, used to spot a revived overdue word.
 */
export function rewardsForEvidence(
  evidence: Evidence,
  prior: SkillCard | undefined,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): RewardEvent[] {
  let kind: RewardKind | null = null;
  switch (evidence.kind) {
    case 'cloze_correct_nohint':
    case 'review_good':
    case 'review_easy':
      kind = 'recall_correct';
      break;
    case 'cloze_correct_hint':
    case 'review_hard':
      kind = 'recall_hinted';
      break;
    default:
      return [];
  }
  const refId = `${evidence.item.kind}:${evidence.item.id}:${evidence.skill}`;
  const out: RewardEvent[] = [];
  const overdueDays =
    prior && prior.state !== 'unseen' && prior.state !== 'introduced'
      ? (evidence.at.getTime() - prior.card.due.getTime()) / DAY_MS
      : 0;
  if (overdueDays >= config.reviveOverdueDays)
    out.push(makeReward('word_revived', evidence.at, refId, config));
  out.push(makeReward(kind, evidence.at, refId, config));
  return out;
}

export function totalPoints(events: readonly Pick<RewardEvent, 'points'>[]): number {
  return events.reduce((sum, e) => sum + e.points, 0);
}
