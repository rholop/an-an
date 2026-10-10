import { describe, expect, it } from 'vitest';
import { computeStreak, streakDays } from '../game/streak.js';
import { activeDaysFromHistory, countsAsActivity, mergeActiveDays } from './active-days.js';
import { buildLedger } from './ledger.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate } from './review-sessions.js';
import { dayKey } from './time.js';

const NY = 'America/New_York';
/** Noon New York time on October `d`, 2026. */
const oct = (d: number, h = 12, m = 0) => zonedDate(2026, 10, d, h, m, NY);
const ledgerAt = (now: Date, activeDays: Iterable<string>) =>
  buildLedger({ cards: [], evidence: [], knownItems: [], session: DEFAULT_SESSION_SETTINGS, masteryShare: 0.8, now, activeDays });

describe('Phase 32: active days', () => {
  it('counts answers, never passive reads, lookups, imports or placement', () => {
    for (const kind of ['review_good', 'cloze_wrong', 'listening_correct', 'reading_tone_wrong', 'journal_misuse', 'known_check_passed'])
      expect(countsAsActivity({ kind }), kind).toBe(true);
    for (const kind of [
      'chat_read_no_lookup',
      'story_read_no_lookup',
      'chat_lookup_gloss',
      'chat_hover_reading',
      'anki_import_seen',
      'placement_known',
      'placement_unknown',
      'textbook_lesson_covered',
      'review_nope',
      'evidence_undone',
    ])
      expect(countsAsActivity({ kind }), kind).toBe(false);
  });

  it('back-fills every past day with evidence even when reward events started later', () => {
    // Evidence on Oct 1–10, reward events only on Oct 8–10 (the owner's case).
    const evidence = Array.from({ length: 10 }, (_, i) => ({ kind: 'review_good', at: oct(i + 1, 9) }));
    const rewards = [8, 9, 10].map((d) => ({ at: oct(d, 9) }));
    const rows = activeDaysFromHistory({ evidence, rewards }, NY);
    expect(rows.map((r) => r.day)).toEqual(Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`));

    const days = rows.map((r) => r.day);
    // Today (Oct 11) not active yet: the run is 10 and still alive.
    expect(ledgerAt(oct(11), days).streak(ledgerAt(oct(11), days).activeDays())).toMatchObject({ current: 10, best: 10 });
    // Active today: 11.
    const withToday = [...days, '2026-10-11'];
    expect(ledgerAt(oct(11), withToday).streak(ledgerAt(oct(11), withToday).activeDays()).current).toBe(11);
  });

  it('reads finished journal entries, stories, completed scenarios and open-chat turns; skips undo rows and passive rows', () => {
    const rows = activeDaysFromHistory(
      {
        evidence: [{ kind: 'chat_read_no_lookup', at: oct(1) }, { kind: 'anki_import_seen', at: oct(2) }],
        rewards: [{ at: oct(3), revokes: 'x' }],
        journalEntries: [
          { status: 'finished', finishedAt: oct(4) },
          { status: 'revealed' },
        ],
        stories: [{ readAt: oct(6), readDates: [oct(5), oct(6)] }, {}],
        conversations: [
          { id: 1, completed: true, endedAt: oct(7) },
          { id: 2, kind: 'open', completed: false },
          { id: 3, completed: false },
        ],
        turns: [
          { conversationId: 2, role: 'learner', at: oct(8) },
          { conversationId: 2, role: 'npc', at: oct(9) },
          { conversationId: 3, role: 'learner', at: oct(10) },
        ],
      },
      NY,
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  });

  it('uses the profile time zone around midnight New York time', () => {
    const late = oct(9, 23, 59); // 03:59 UTC on Oct 10
    const early = oct(10, 0, 1);
    const rows = activeDaysFromHistory({ evidence: [{ kind: 'review_good', at: late }, { kind: 'review_good', at: early }] }, NY);
    expect(rows.map((r) => r.day)).toEqual(['2026-10-09', '2026-10-10']);
    expect(dayKey(late, 'UTC')).toBe('2026-10-10');
    expect(activeDaysFromHistory({ evidence: [{ kind: 'review_good', at: late }] }, 'UTC')[0]!.day).toBe('2026-10-10');
  });

  it('counts a DST day as one day (fall back, Nov 1 2026)', () => {
    const before = zonedDate(2026, 11, 1, 0, 30, NY);
    const after = zonedDate(2026, 11, 1, 23, 30, NY); // 25-hour day
    const rows = activeDaysFromHistory(
      { evidence: [{ kind: 'review_good', at: zonedDate(2026, 10, 31, 12, 0, NY) }, { kind: 'review_good', at: before }, { kind: 'review_good', at: after }] },
      NY,
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-10-31', '2026-11-01']);
    expect(computeStreak(rows.map((r) => r.day), zonedDate(2026, 11, 2, 0, 30, NY), undefined, NY).current).toBe(2);
  });

  it('two devices back-filling the same profile end up with the same rows', () => {
    const a = activeDaysFromHistory({ evidence: [{ kind: 'review_good', at: oct(1, 8) }, { kind: 'review_good', at: oct(2, 8) }] }, NY);
    const b = activeDaysFromHistory({ evidence: [{ kind: 'review_good', at: oct(1, 7) }, { kind: 'review_good', at: oct(3, 8) }] }, NY);
    const ab = mergeActiveDays(a, b);
    const ba = mergeActiveDays(b, a);
    expect(ab).toEqual(ba);
    expect(ab.map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(ab[0]!.at).toEqual(oct(1, 7));
    expect(mergeActiveDays(ab, ab)).toEqual(ab);
  });

  it('the bar shows the last 7 days: active, freeze, missed and today', () => {
    // Active Oct 3, 5, 6, 7, 9; Oct 4 and 8 are freeze days inside the run (2 a week); Oct 2 was before it.
    const active = ['2026-10-03', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09'].map(String);
    const week = streakDays(active, oct(10), undefined, NY);
    expect(week.map((d) => `${d.day.slice(8)}:${d.status}`)).toEqual([
      '04:freeze',
      '05:active',
      '06:active',
      '07:active',
      '08:freeze',
      '09:active',
      '10:today',
    ]);
    expect(streakDays([...active, '2026-10-10'], oct(10), undefined, NY).at(-1)!.status).toBe('active');
    expect(streakDays([], oct(10), undefined, NY).map((d) => d.status)).toEqual([
      'missed',
      'missed',
      'missed',
      'missed',
      'missed',
      'missed',
      'today',
    ]);
    // A gap longer than the allowance: the run restarts and the gap days are missed.
    const broken = streakDays(['2026-10-01', '2026-10-09'], oct(9), { enabled: true, freezeDaysPerWeek: 1 }, NY);
    expect(broken.map((d) => d.status)).toEqual(['missed', 'missed', 'missed', 'missed', 'missed', 'missed', 'active']);
  });

  it('the ledger knows whether today is active', () => {
    expect(ledgerAt(oct(10), ['2026-10-10']).activeToday()).toBe(true);
    expect(ledgerAt(oct(10), ['2026-10-09']).activeToday()).toBe(false);
  });
});
