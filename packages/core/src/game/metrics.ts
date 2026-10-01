import type { Evidence } from '../types.js';
import type { ConversationRecord } from './scenario-progress.js';

const GRADED: Record<string, boolean> = {
  review_again: false,
  review_hard: true,
  review_good: true,
  review_easy: true,
  cloze_correct_nohint: true,
  cloze_correct_hint: true,
  cloze_wrong: false,
};

export interface RetentionStats {
  /** Successful recalls / graded reviews; null with no data. */
  actual: number | null;
  reviews: number;
  target: number;
}

/**
 * Review retention vs. target (CLAUDE.md "How we'll know it works"). Only
 * graded recall evidence counts, and the *first* graded answer for each
 * (item, skill) is excluded — that is a learning step, not a retention
 * measurement; FSRS's target applies to reviews of cards already learned.
 */
export function actualRetention(
  evidence: readonly Evidence[],
  target: number,
  since?: Date,
): RetentionStats {
  const ordered = [...evidence]
    .filter((e) => e.kind in GRADED)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const seen = new Set<string>();
  let reviews = 0;
  let ok = 0;
  for (const e of ordered) {
    const key = `${e.item.kind}:${e.item.id}:${e.skill}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    if (since && e.at < since) continue;
    reviews++;
    if (GRADED[e.kind]) ok++;
  }
  return { actual: reviews === 0 ? null : ok / reviews, reviews, target };
}

export interface ScenarioMetrics {
  attempts: number;
  completed: number;
  /** Completed with no "I'm stuck" and no English fallback. */
  completedUnassisted: number;
  /** Share of completed runs that were unassisted; null with none. */
  unassistedRate: number | null;
  /** Mean time of unassisted completions, in ms. */
  meanUnassistedMs: number | null;
  /** 1 - stuck presses / learner turns, capped to [0,1]; null with no turns. */
  turnsWithoutStuck: number | null;
}

export function scenarioMetrics(
  conversations: readonly (ConversationRecord & { learnerTurns?: number })[],
): ScenarioMetrics {
  const done = conversations.filter((c) => c.completed);
  const unassisted = done.filter((c) => c.stuckCount === 0 && !c.englishFallbackUsed);
  const times = unassisted
    .filter((c) => c.endedAt)
    .map((c) => c.endedAt!.getTime() - c.startedAt.getTime());
  const turns = conversations.reduce((s, c) => s + (c.learnerTurns ?? 0), 0);
  const stuck = conversations.reduce(
    (s, c) => s + Math.min(c.stuckCount, c.learnerTurns ?? c.stuckCount),
    0,
  );
  return {
    attempts: conversations.length,
    completed: done.length,
    completedUnassisted: unassisted.length,
    unassistedRate: done.length === 0 ? null : unassisted.length / done.length,
    meanUnassistedMs: times.length === 0 ? null : times.reduce((a, b) => a + b, 0) / times.length,
    turnsWithoutStuck: turns === 0 ? null : Math.max(0, 1 - stuck / turns),
  };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
