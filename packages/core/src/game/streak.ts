import { activeRewards } from './rewards.js';
import { DEFAULT_SESSION_SETTINGS } from '../progress/review-sessions.js';
import { addDaysToKey, dayKey, daysBetweenKeys, weekRange } from '../progress/time.js';

export interface StreakConfig {
  /** Off by default (phase doc §5). Nothing in the UI mentions streaks unless on. */
  enabled: boolean;
  /** Days that may be skipped in any rolling 7 without ending the run. */
  freezeDaysPerWeek: number;
}

export const DEFAULT_STREAK_CONFIG: StreakConfig = { enabled: false, freezeDaysPerWeek: 2 };


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
  /** Active days as profile-zone day keys (`dayKey`). */
  activeDays: Iterable<string>,
  today: Date,
  config: StreakConfig = DEFAULT_STREAK_CONFIG,
  timeZone: string = DEFAULT_SESSION_SETTINGS.timeZone,
): StreakResult {
  const active = new Set(activeDays);
  if (active.size === 0) return { current: 0, best: 0, freezesUsed: 0 };
  const first = [...active].sort()[0]!;
  const days = daysBetweenKeys(first, dayKey(today, timeZone));

  let run = 0;
  let best = 0;
  const recentSkips: number[] = []; // indices of skipped days still inside the 7-day window
  for (let i = 0; i <= days; i++) {
    const key = addDaysToKey(first, i);
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

/** Phase 6 §5: a weekly summary instead of a daily nag. Phase 29: "this week" is Monday to Sunday
 * in the profile's time zone, like every other week in the app. Purely descriptive. */
export function weeklySummary(
  events: readonly { id?: string; kind: string; points: number; at: Date; refId?: string; revokes?: string }[],
  now: Date,
  timeZone: string = DEFAULT_SESSION_SETTINGS.timeZone,
): WeeklySummary {
  const { from, to } = weekRange(now, timeZone);
  // Phase 21: undone answers (and their revoking events) don't count; points still net out.
  const all = events.filter((e) => e.at >= from && e.at < to);
  const inWeek = activeRewards(all.map((e, i) => ({ ...e, id: e.id ?? `#${i}` })));
  const count = (...kinds: string[]) => inWeek.filter((e) => kinds.includes(e.kind)).length;
  return {
    from,
    to,
    points: inWeek.reduce((s, e) => s + e.points, 0),
    activeDays: new Set(inWeek.map((e) => dayKey(e.at, timeZone))).size,
    // Phase 21: distinct WORDS recalled (not word+skill pairs per day, and not grammar points).
    wordsRecalled: new Set(
      inWeek
        .filter((e) => ['recall_correct', 'recall_hinted', 'recall_wrong_tone'].includes(e.kind))
        .map((e) => e.refId ?? `${e.kind}:${e.at.getTime()}`)
        .filter((ref) => !ref.startsWith('grammar:'))
        .map((ref) => (ref.startsWith('word:') ? ref.split(':')[1] : ref)),
    ).size,
    scenariosCompleted: count('scenario_completed'),
    journalEntries: count('journal_entry'),
    mistakesFixed: count('error_fixed', 'self_correction'),
  };
}
