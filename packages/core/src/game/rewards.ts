import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';
import { DEFAULT_SESSION_SETTINGS } from '../progress/review-sessions.js';
import { dayKey } from '../progress/time.js';
import { overdueDaysAt } from '../progress/terms.js';

/**
 * Phase 6 §1: points are earned only by learning behaviours. Everything the
 * game can ever award is a row in REWARD_TABLE — there is deliberately no
 * kind for time spent, opening the app, or a login streak, and the test suite
 * pins that (rewards.test.ts).
 */
export type RewardKind =
  | 'recall_correct'
  | 'recall_hinted'
  | 'recall_wrong_tone'
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
    label: 'Recalled a word (hard)',
    behaviour: 'successful recall that took effort (Hard, or after replays)',
  },
  recall_wrong_tone: {
    points: 1,
    label: 'Right word, wrong tone',
    behaviour: 'produced the right word with a wrong tone',
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
  /** Phase 21 Undo: this event takes back the event with this id (negative points, same kind). */
  revokes?: string;
}

/** Phase 21 Undo: the event that takes `e` back (append-only, so it survives sync). */
export function revokeReward(e: Pick<RewardEvent, 'id' | 'kind' | 'points' | 'refId'>, at: Date): RewardEvent {
  return { id: `undo:${e.id}`, kind: e.kind, points: -e.points, at, ...(e.refId ? { refId: e.refId } : {}), revokes: e.id };
}

/** Events that still count: revoked events and the revoking events themselves drop out. */
export function activeRewards<T extends { id: string; revokes?: string }>(events: readonly T[]): T[] {
  const revoked = new Set(events.flatMap((e) => (e.revokes ? [e.revokes] : [])));
  return events.filter((e) => !e.revokes && !revoked.has(e.id));
}



export function makeReward(
  kind: RewardKind,
  at: Date,
  refId: string,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
  /** The profile's time zone: one reward of a kind per item per profile-zone day. */
  timeZone: string = DEFAULT_SESSION_SETTINGS.timeZone,
): RewardEvent {
  return {
    id: `${kind}:${refId}:${dayKey(at, timeZone)}`,
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
  timeZone: string = DEFAULT_SESSION_SETTINGS.timeZone,
): RewardEvent[] {
  let kind: RewardKind | null = null;
  // Phase 21: listening and journal recalls earn the same points as review and cloze recalls.
  // Phase 29 Part B.14: Pinyin & tones answers too (a tone slip earns like a hinted cloze).
  switch (evidence.kind) {
    case 'cloze_correct_nohint':
    case 'review_good':
    case 'review_easy':
    case 'listening_correct':
    case 'journal_correct_use':
    case 'reading_correct':
      kind = 'recall_correct';
      break;
    case 'review_hard':
    case 'listening_correct_replayed':
      kind = 'recall_hinted';
      break;
    case 'cloze_correct_hint':
    case 'reading_tone_wrong':
      kind = 'recall_wrong_tone';
      break;
    default:
      return [];
  }
  const refId = `${evidence.item.kind}:${evidence.item.id}:${evidence.skill}`;
  const out: RewardEvent[] = [];
  if (overdueDaysAt(prior, evidence.at) >= config.reviveOverdueDays)
    out.push(makeReward('word_revived', evidence.at, refId, config, timeZone));
  out.push(makeReward(kind, evidence.at, refId, config, timeZone));
  return out;
}

export function totalPoints(events: readonly Pick<RewardEvent, 'points'>[]): number {
  return events.reduce((sum, e) => sum + e.points, 0);
}

/** Phase 21: evidence that still counts: answers taken back by an `evidence_undone` record drop out
 * (with the undo records themselves). Rows written before sync uids existed always count. */
export function activeEvidence<T extends { kind: string; uid?: string; context?: { refId?: string } }>(rows: readonly T[]): T[] {
  const undone = new Set(rows.flatMap((e) => (e.kind === 'evidence_undone' && e.context?.refId ? [e.context.refId] : [])));
  return rows.filter((e) => e.kind !== 'evidence_undone' && !(e.uid && undone.has(e.uid)));
}
