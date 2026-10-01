import { dayKey } from './rewards.js';

export interface StreakConfig {
  /** Off by default (phase doc §5). Nothing in the UI mentions streaks unless on. */
  enabled: boolean;
  /** Days that may be skipped in any rolling 7 without ending the run. */
  freezeDaysPerWeek: number;
}

export const DEFAULT_STREAK_CONFIG: StreakConfig = { enabled: false, freezeDaysPerWeek: 2 };

const DAY_MS = 86_400_000;
const parseKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export interface StreakResult {
  /** Active days in the current run (freeze days don't count as active). */
  current: number;
  /** Best run ever — never reduced. */
  best: number;
  /** Freeze days spent inside the current run's last 7 days. */
  freezesUsed: number;
}

/**
 * A gentle streak: a run continues across skipped days as long as no more
 * than `freezeDaysPerWeek` of any 7 consecutive days are skipped. Today being
 * empty never breaks anything (the day isn't over). A broken run just starts
 * a new one; `best` is kept, and nothing here ever produces a negative value
 * or a penalty.
 */
export function computeStreak(
  activeDays: Iterable<string>,
  today: Date,
  config: StreakConfig = DEFAULT_STREAK_CONFIG,
): StreakResult {
  const active = new Set(activeDays);
  if (active.size === 0) return { current: 0, best: 0, freezesUsed: 0 };
  const first = [...active].sort()[0]!;
  const start = parseKey(first);
  const days = Math.round((parseKey(dayKey(today)).getTime() - start.getTime()) / DAY_MS);

  let run = 0;
  let best = 0;
  const recentSkips: number[] = []; // indices of skipped days still inside the 7-day window
  for (let i = 0; i <= days; i++) {
    const key = dayKey(addDays(start, i));
    if (active.has(key)) {
      run++;
      best = Math.max(best, run);
      continue;
    }
    if (i === days) break; // today, still open
    while (recentSkips.length > 0 && recentSkips[0]! <= i - 7) recentSkips.shift();
    if (recentSkips.length < config.freezeDaysPerWeek && run > 0) {
      recentSkips.push(i);
    } else {
      run = 0;
      recentSkips.length = 0;
    }
  }
  const freezesUsed = recentSkips.filter((i) => i > days - 7).length;
  return { current: run, best, freezesUsed };
}

export interface WeeklySummary {
  from: Date;
  to: Date;
  points: number;
  activeDays: number;
  wordsRecalled: number;
  scenariosCompleted: number;
  journalEntries: number;
  mistakesFixed: number;
}

/** Phase 6 §5: a weekly summary instead of a daily nag. Counts the 7 days
 * ending at `now`'s day. Purely descriptive — no goals, no shortfalls. */
export function weeklySummary(
  events: readonly { kind: string; points: number; at: Date }[],
  now: Date,
): WeeklySummary {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = addDays(to, -7);
  const inWeek = events.filter((e) => e.at >= from && e.at < to);
  const count = (...kinds: string[]) => inWeek.filter((e) => kinds.includes(e.kind)).length;
  return {
    from,
    to,
    points: inWeek.reduce((s, e) => s + e.points, 0),
    activeDays: new Set(inWeek.map((e) => dayKey(e.at))).size,
    wordsRecalled: count('recall_correct', 'recall_hinted'),
    scenariosCompleted: count('scenario_completed'),
    journalEntries: count('journal_entry'),
    mistakesFixed: count('error_fixed', 'self_correction'),
  };
}
