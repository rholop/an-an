// Phase 49: test prep settings, reminders, the after-test line, reading accuracy and pass marks.
import { describe, expect, it } from 'vitest';
import { zonedDate } from './review-sessions.js';
import {
  readingAccuracyOf,
  sanitizeTestPrep,
  testPrepView,
  underPassMarks,
  type AccuracyEvidence,
  type TestPrepSettings,
  type TestResult,
} from './test-prep.js';
import { countsAsActivity } from './active-days.js';

const TZ = 'America/New_York';
const ny = (m: number, d: number, h = 12) => zonedDate(2026, m, d, h, 0, TZ);
const result = (date: string, over: Partial<TestResult> = {}): TestResult => ({
  id: `r-${date}`,
  date,
  kind: 'mock',
  createdAt: new Date(`${date}T20:00:00Z`),
  updatedAt: new Date(`${date}T20:00:00Z`),
  ...over,
});
// switched on Monday 2026-10-19 (New York)
const prep: TestPrepSettings = { on: true, target: 'L2', startedAt: ny(10, 19, 9).toISOString() };

describe('Phase 49: settings', () => {
  it('defaults: off, target L2; a target outside the offered ones falls back to L2', () => {
    expect(sanitizeTestPrep(undefined)).toEqual({ on: false, target: 'L2' });
    expect(sanitizeTestPrep({ on: true, target: 'L5', testDate: 'soon' })).toEqual({ on: true, target: 'L2' });
    expect(sanitizeTestPrep({ on: true, target: 'L1', testDate: '2027-04-10' })).toEqual({ on: true, target: 'L1', testDate: '2027-04-10' });
  });

  it('the must-pass level is L1, never above the target; days to the test count profile-zone days', () => {
    const v = testPrepView({ ...prep, testDate: '2026-10-25' }, [], ny(10, 20, 23), TZ);
    expect(v.mustPass).toBe('L1');
    expect(v.daysToTest).toBe(5);
  });
});

describe('Phase 49: reminders (Home lines, not notifications)', () => {
  it('week 4 shows on its day, not before, and clears once a result is logged', () => {
    expect(testPrepView(prep, [], ny(11, 15), TZ).reminder).toBeUndefined();
    expect(testPrepView(prep, [], ny(11, 16), TZ).reminder).toBe('mock-week-4');
    expect(testPrepView(prep, [result('2026-11-17')], ny(11, 18), TZ).reminder).toBeUndefined();
    // a result from before the reminder does not clear it
    expect(testPrepView(prep, [result('2026-11-01')], ny(11, 18), TZ).reminder).toBe('mock-week-4');
  });

  it('week 7 shows on its day and clears after a later result; a deleted result clears nothing', () => {
    expect(testPrepView(prep, [result('2026-11-17')], ny(12, 7), TZ).reminder).toBe('mock-week-7');
    expect(testPrepView(prep, [result('2026-11-17'), result('2026-12-08')], ny(12, 9), TZ).reminder).toBeUndefined();
    expect(testPrepView(prep, [result('2026-12-08', { deleted: true })], ny(12, 9), TZ).reminder).toBe('mock-week-7');
  });

  it('the day after the test date: "Test day has passed", until a result from that day on is logged', () => {
    const p = { ...prep, testDate: '2027-04-10' };
    expect(testPrepView(p, [], zonedDate(2027, 4, 10, 20, 0, TZ), TZ).reminder).not.toBe('after-test');
    expect(testPrepView(p, [], zonedDate(2027, 4, 11, 0, 30, TZ), TZ).reminder).toBe('after-test');
    expect(testPrepView(p, [result('2027-04-10', { kind: 'official' })], zonedDate(2027, 4, 12, 9, 0, TZ), TZ).reminder).toBeUndefined();
  });

  it('nothing shows while prep is off; the latest result is the newest by date', () => {
    expect(testPrepView({ ...prep, on: false }, [], ny(12, 9), TZ).reminder).toBeUndefined();
    const v = testPrepView(prep, [result('2026-12-01'), result('2026-11-20')], ny(12, 9), TZ);
    expect(v.latest?.date).toBe('2026-12-01');
    expect(v.results.map((r) => r.date)).toEqual(['2026-11-20', '2026-12-01']);
  });
});

describe('Phase 49: reading accuracy', () => {
  const now = ny(10, 20, 18);
  const ev = (id: string, kind: string, at: Date, over: Partial<AccuracyEvidence> = {}): AccuracyEvidence => ({
    item: { kind: 'word', id },
    skill: 'recognition',
    kind,
    at,
    ...over,
  });
  const test = (id: string) => id.startsWith('t');

  it('is null under 20 answers, then the share of right first answers', () => {
    const rows = Array.from({ length: 19 }, (_, i) => ev(`t${i}`, 'drill_correct', ny(10, 20, 9)));
    expect(readingAccuracyOf(rows, test, now, TZ)).toBeNull();
    const more = [...rows, ev('t99', 'drill_wrong', ny(10, 20, 9))];
    expect(readingAccuracyOf(more, test, now, TZ)).toEqual({ correct: 19, total: 20, share: 0.95 });
  });

  it('counts only the first Meaning answer of the day on a test word, never Say it, never a drill\'s own review row', () => {
    const rows: AccuracyEvidence[] = [
      ev('t1', 'review_again', ny(10, 20, 8)),
      ev('t1', 'review_good', ny(10, 20, 9)), // second answer that day: not counted
      ev('t2', 'review_good', ny(10, 20, 8), { context: { face: 'meaning' } }),
      ev('t3', 'review_good', ny(10, 20, 8), { skill: 'reading' }), // Say it
      ev('t4', 'review_good', ny(10, 20, 8), { skill: 'production', context: { face: 'pick' } }),
      ev('t5', 'review_good', ny(10, 20, 8), { context: { source: 'drill' } }),
      ev('x1', 'review_good', ny(10, 20, 8)), // not a test word
      ev('t6', 'drill_correct', ny(10, 13, 8)), // 8 days ago: outside the window
    ];
    expect(readingAccuracyOf(rows, test, now, TZ, 7, 1)).toEqual({ correct: 1, total: 2, share: 0.5 });
  });

  it('a drill answer makes the day active (it is an answer)', () => {
    expect(countsAsActivity({ kind: 'drill_correct' })).toBe(true);
    expect(countsAsActivity({ kind: 'drill_wrong' })).toBe(true);
  });
});

describe('Phase 49: pass marks are config, unverified', () => {
  it('flags a mock under the L1 marks; L2 has none yet', () => {
    expect(underPassMarks({ listening: { score: 20 }, reading: { score: 17 } })).toEqual(['reading', 'total']);
    expect(underPassMarks({ listening: { score: 25 }, reading: { score: 20 } })).toEqual([]);
    expect(underPassMarks({ listening: { level: 'L1' }, reading: { level: 'L1' } })).toEqual([]);
    expect(underPassMarks({ reading: { score: 1 } }, 'L2')).toEqual([]);
  });
});
