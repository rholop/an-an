// Phase 49 (owner, 2026-10-19: "I need to pass TOCFL and I want to be able to prove my language
// abilities — ideally beyond level 1"): TOCFL test prep. A switch in Settings → Study (target level,
// optional test date) that promotes the TOCFL words up to the target in the study order, inside the
// Phase 43 limits; the numbers behind the Home readiness line (coverage, reading accuracy over the
// drill and Meaning answers, the latest mock); reminders to log a mock. The ledger is the only door
// to these numbers (`ledger.testCoverage()`, `ledger.readingAccuracy()`, `ledger.testPrep()`).
// Pure; time is injected.

import { LEVEL_IDS, levelIndex, type Level } from '../levels.config.js';
import { addDaysToKey, daysBetweenKeys, dayKey } from './time.js';

/** A pass mark as the owner found it. `verified: false` until checked against a current SC-TOP notice. */
export interface PassMark {
  total?: number;
  listening?: number;
  reading?: number;
  verified: boolean;
  source: string;
}

export const TEST_PREP_CONFIG = {
  /** The level the test must be passed at (fixed below the target). */
  mustPass: 'L1' as Level,
  /** Target levels the setting offers (from `levels.config.ts`). */
  targets: ['L1', 'L2'] as readonly Level[],
  defaultTarget: 'L2' as Level,
  /** Drill: items per round and the gentle timer per item. */
  itemsPerRound: 5,
  secondsPerItem: 60,
  /** Reading accuracy: the window (profile-zone days) and the fewest answers that give a number. */
  accuracyDays: 7,
  accuracyMinAnswers: 20,
  /** "A good week for a mock test": weeks after test prep was switched on. */
  reminderWeeks: [4, 7] as readonly number[],
  /** Drill passages: comprehensible-or-test-word share and words above the target. */
  passageCoverage: 0.95,
  passageMaxAboveTarget: 2,
  /**
   * Pass marks per level, UNVERIFIED: the 2020 SC-TOP notice (華語文能力測驗證書核發規範調整公告)
   * as cited in the owner's draft brief could not be confirmed, and the CAT may report a level per
   * skill instead of a score. Shown only on the results screen, always as "(unverified pass mark)".
   * L2 stays empty until the owner confirms it.
   */
  passMarks: {
    L1: { total: 42, listening: 17, reading: 18, verified: false, source: '2020 SC-TOP notice, as cited in the Phase 49 draft (unconfirmed)' },
  } as Partial<Record<Level, PassMark>>,
} as const;

/** Settings → Study → "TOCFL test prep" (per profile, synced with the study settings). */
export interface TestPrepSettings {
  on: boolean;
  target: Level;
  /** Optional test date, a day key (YYYY-MM-DD). */
  testDate?: string;
  /** When test prep was last switched on (ISO): the week-4 and week-7 reminders count from it. */
  startedAt?: string;
}

export const DEFAULT_TEST_PREP: TestPrepSettings = { on: false, target: TEST_PREP_CONFIG.defaultTarget };

/** One skill on a result: a score or a level, whichever the report gives. */
export interface TestSkillResult {
  score?: number;
  level?: Level;
}

/** A logged mock or official result (the synced `testResults` table). */
export interface TestResult {
  id: string;
  /** The day of the test (YYYY-MM-DD). */
  date: string;
  kind: 'mock' | 'official';
  listening?: TestSkillResult;
  reading?: TestSkillResult;
  /** Removed by the learner (kept so the removal syncs). */
  deleted?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The levels the target covers, lowest first (test words are TOCFL words at or below it). */
export function levelsUpTo(target: Level): Level[] {
  return LEVEL_IDS.filter((l) => levelIndex(l) <= levelIndex(target));
}

/** The must-pass level, never above the target. */
export function mustPassFor(target: Level): Level {
  return levelIndex(TEST_PREP_CONFIG.mustPass) <= levelIndex(target) ? TEST_PREP_CONFIG.mustPass : target;
}

/** A clean copy of stored settings (anything odd falls back to the defaults). */
export function sanitizeTestPrep(v: unknown): TestPrepSettings {
  const o = (v ?? {}) as Partial<TestPrepSettings>;
  const target = TEST_PREP_CONFIG.targets.includes(o.target as Level) ? (o.target as Level) : TEST_PREP_CONFIG.defaultTarget;
  const date = typeof o.testDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.testDate) ? o.testDate : undefined;
  const started = typeof o.startedAt === 'string' && !Number.isNaN(Date.parse(o.startedAt)) ? o.startedAt : undefined;
  return { on: o.on === true, target, ...(date ? { testDate: date } : {}), ...(started ? { startedAt: started } : {}) };
}

export type TestReminder = 'mock-week-4' | 'mock-week-7' | 'after-test';

export interface TestPrepView {
  on: boolean;
  target: Level;
  mustPass: Level;
  testDate?: string;
  /** Whole profile-zone days from today to the test date (0 on the day, negative after). */
  daysToTest?: number;
  /** The newest logged result (by its date, then when it was logged), deleted ones left out. */
  latest?: TestResult;
  /** Every logged result, oldest first (the trend). */
  results: TestResult[];
  /** The one Home reminder line due now, if any. */
  reminder?: TestReminder;
}

/** The results that count (not deleted), oldest first. */
export function liveResults(results: readonly TestResult[]): TestResult[] {
  return results
    .filter((r) => !r.deleted)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/**
 * The prep view (`ledger.testPrep()`). Reminders are Home lines, not notifications:
 * - after the test date (the day after it): "Test day has passed · Log your result", until a result
 *   dated on or after the test day is logged;
 * - week 4 and week 7 after prep was switched on: "A good week for a mock test", each cleared once a
 *   result is logged on or after its day. Only the latest one due shows.
 */
export function testPrepView(settings: TestPrepSettings, results: readonly TestResult[], now: Date, timeZone: string): TestPrepView {
  const live = liveResults(results);
  const today = dayKey(now, timeZone);
  const latest = live[live.length - 1];
  const loggedOnOrAfter = (day: string) => live.some((r) => r.date >= day || dayKey(r.createdAt, timeZone) >= day);
  let reminder: TestReminder | undefined;
  if (settings.on) {
    if (settings.testDate && today > settings.testDate && !live.some((r) => r.date >= settings.testDate!)) reminder = 'after-test';
    else if (settings.startedAt) {
      const start = dayKey(new Date(settings.startedAt), timeZone);
      for (const w of [...TEST_PREP_CONFIG.reminderWeeks].sort((a, b) => b - a)) {
        const day = addDaysToKey(start, w * 7);
        if (today < day) continue;
        if (!loggedOnOrAfter(day)) reminder = w === 4 ? 'mock-week-4' : 'mock-week-7';
        break;
      }
    }
  }
  return {
    on: settings.on,
    target: settings.target,
    mustPass: mustPassFor(settings.target),
    ...(settings.testDate ? { testDate: settings.testDate, daysToTest: daysBetweenKeys(today, settings.testDate) } : {}),
    ...(latest ? { latest } : {}),
    results: live,
    ...(reminder ? { reminder } : {}),
  };
}

/** Which unverified pass marks a result is under (results screen only). */
export function underPassMarks(r: Pick<TestResult, 'listening' | 'reading'>, level: Level = TEST_PREP_CONFIG.mustPass): Array<'total' | 'listening' | 'reading'> {
  const mark = TEST_PREP_CONFIG.passMarks[level];
  if (!mark) return [];
  const out: Array<'total' | 'listening' | 'reading'> = [];
  const l = r.listening?.score;
  const rd = r.reading?.score;
  if (mark.listening !== undefined && l !== undefined && l < mark.listening) out.push('listening');
  if (mark.reading !== undefined && rd !== undefined && rd < mark.reading) out.push('reading');
  if (mark.total !== undefined && l !== undefined && rd !== undefined && l + rd < mark.total) out.push('total');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading accuracy

/** Phase 49: a drill item's result, for `readingAccuracy` (never moves a card). */
export const DRILL_KINDS: ReadonlySet<string> = new Set(['drill_correct', 'drill_wrong']);

export interface AccuracyEvidence {
  item: { kind: string; id: string };
  skill: string;
  kind: string;
  at: Date;
  context?: { source?: string; face?: string };
}

export interface ReadingAccuracy {
  correct: number;
  total: number;
  share: number;
}

const MEANING_KINDS = new Set(['review_again', 'review_hard', 'review_good', 'review_easy']);

/**
 * The share of right FIRST answers over the last `days` profile-zone days, from two sources: drill
 * items (`drill_*`, each item once) and the first Meaning-face answer of the day on a test word.
 * Never from the `reading` skill (that is pronunciation, Say it). `null` under the minimum.
 */
export function readingAccuracyOf(
  evidence: readonly AccuracyEvidence[],
  isTestWord: (id: string) => boolean,
  now: Date,
  timeZone: string,
  days: number = TEST_PREP_CONFIG.accuracyDays,
  minAnswers: number = TEST_PREP_CONFIG.accuracyMinAnswers,
): ReadingAccuracy | null {
  const today = dayKey(now, timeZone);
  const first = addDaysToKey(today, -(days - 1));
  const seen = new Set<string>();
  let correct = 0;
  let total = 0;
  const rows = [...evidence].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const e of rows) {
    if (e.at.getTime() > now.getTime() || e.skill === 'reading') continue;
    const day = dayKey(e.at, timeZone);
    if (day < first || day > today) continue;
    let right: boolean;
    if (DRILL_KINDS.has(e.kind)) right = e.kind === 'drill_correct';
    else if (
      MEANING_KINDS.has(e.kind) &&
      e.skill === 'recognition' &&
      e.item.kind === 'word' &&
      e.context?.source !== 'drill' &&
      (e.context?.face === undefined || e.context.face === 'meaning') &&
      isTestWord(e.item.id)
    ) {
      const key = `${day}|${e.item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      right = e.kind !== 'review_again';
    } else continue;
    total++;
    if (right) correct++;
  }
  if (total < minAnswers) return null;
  return { correct, total, share: correct / total };
}
