import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';
import {
  DEFAULT_SESSION_SETTINGS,
  sanitizeSessionSettings,
  sessionAt,
  zonedDate,
  zonedParts,
  type SessionSettings,
} from './review-sessions.js';
import { newWordState, reviewStatus, sessionCards, sessionForecast } from './review-status.js';

const TZ = 'America/New_York';
const S: SessionSettings = { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ };
/** A wall-clock time in New York, whatever zone the tests run in. */
const ny = (month: number, day: number, h: number, m = 0) => zonedDate(2026, month, day, h, m, TZ);

function card(id: string, due: Date, over: Partial<SkillCard> = {}): SkillCard {
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...createEmptyCard(ny(10, 1, 0)), due, reps: 2, stability: 5 },
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: ny(10, 1, 0),
    ...over,
  };
}

const answer = (
  id: string,
  kind: Evidence['kind'],
  at: Date,
  skill: Evidence['skill'] = 'recognition',
): Evidence => ({ item: { kind: 'word', id }, skill, kind, at });

describe('review sessions (Phase 23 Part A)', () => {
  it("the owner's case: 14:00 in New York, 23 cards due between 10:00 and 16:00", () => {
    const cards = [
      ...Array.from({ length: 23 }, (_, i) => card(`mid-${i}`, ny(10, 8, 10, i * 15))),
      card('tomorrow-early', ny(10, 9, 7)),
      card('tomorrow-late', ny(10, 9, 11)),
    ];
    const at2 = reviewStatus({ cards, evidence: [], now: ny(10, 8, 14), settings: S });
    expect(at2.session).toBe('between');
    expect(at2.sessionCards).toBe(0);
    expect(at2.dueNow).toBe(0);
    expect(at2.reviewAll).toBe(0);
    expect(at2.previousSession).toEqual({ name: 'morning', left: 0 });
    expect(at2.nextSession.name).toBe('evening');
    expect(at2.nextSession.opensAt).toEqual(ny(10, 8, 16));
    // the 23, plus what falls due before 10:00 tomorrow (no odd times: one number for the session)
    expect(at2.nextSession.count).toBe(24);

    const at4 = reviewStatus({ cards, evidence: [], now: ny(10, 8, 16), settings: S });
    expect(at4.session).toBe('evening');
    expect(at4.sessionCards).toBe(24);
    expect(at4.sessionEndsAt).toEqual(ny(10, 9, 4));
    const inEvening = sessionCards({ cards, evidence: [], now: ny(10, 8, 16), settings: S }).cards.map((c) => c.item.id);
    expect(inEvening).toContain('tomorrow-early');
    expect(inEvening).not.toContain('tomorrow-late');
    expect(at4.nextSession).toMatchObject({ name: 'morning', count: 1 });
  });

  it('a session nobody does rolls into the next one; Review early opens the next session now', () => {
    const cards = [card('missed', ny(10, 8, 6)), card('later', ny(10, 8, 13))];
    const s = reviewStatus({ cards, evidence: [], now: ny(10, 8, 12), settings: S });
    expect(s.previousSession).toEqual({ name: 'morning', left: 1 });
    expect(s.nextSession.count).toBe(2);
    expect(sessionCards({ cards, evidence: [], now: ny(10, 8, 12), settings: S }).cards).toHaveLength(0);
    const early = sessionCards({ cards, evidence: [], now: ny(10, 8, 12), settings: S, early: true });
    expect(early.cards).toHaveLength(2);
    expect(early.window?.name).toBe('evening');
  });

  it('the cap is per session: 80 in the morning, 80 in the evening; the 81st waits for the next one', () => {
    const cards = Array.from({ length: 90 }, (_, i) => card(`w${i}`, ny(10, 8, 5)));
    // 80 answered this morning: those cards moved on (they're finished this session)
    const evidence = Array.from({ length: 80 }, (_, i) => answer(`w${i}`, 'review_good', ny(10, 8, 6)));
    const morning = reviewStatus({ cards, evidence, now: ny(10, 8, 9), settings: S, baseNew: 5 });
    expect(morning.doneThisSession).toBe(80);
    expect(morning.capLeft).toBe(0);
    expect(morning.reviewAll).toBe(0);
    expect(morning.sessionCards).toBe(10);
    expect(morning.newState).toBe('limit_reached');
    expect(morning.newMessage).toBe("You've done this session's 80 reviews. New words return next session.");

    const left = cards.slice(80);
    const evening = reviewStatus({ cards: left, evidence, now: ny(10, 8, 17), settings: S, baseNew: 5 });
    expect(evening.doneThisSession).toBe(0);
    expect(evening.capLeft).toBe(80);
    expect(evening.reviewAll).toBe(10);
    expect(evening.newState).toBe('open');
    expect(evening.newAllowed).toBe(5);
  });

  it('Again repeats count once; a finished card (even a short learning step) waits for the next session', () => {
    const cards = [
      card('a', ny(10, 8, 8, 10)), // answered Again then Good: its 10-minute step is due inside the session
      card('b', ny(10, 8, 8, 1)), // answered Again only: unfinished, still in the session
      card('c', ny(10, 8, 7)),
    ];
    const evidence = [
      answer('a', 'review_again', ny(10, 8, 8)),
      answer('a', 'review_good', ny(10, 8, 8, 5)),
      answer('b', 'review_again', ny(10, 8, 8)),
      answer('old', 'review_good', ny(10, 7, 20)), // last evening
      answer('c', 'cloze_correct_nohint', ny(10, 8, 8)), // a Water all cloze finishes it too, but isn't a review
    ];
    const s = reviewStatus({ cards, evidence, now: ny(10, 8, 9), settings: S });
    expect(s.doneThisSession).toBe(2);
    expect(s.sessionCards).toBe(1);
    expect(sessionCards({ cards, evidence, now: ny(10, 8, 9), settings: S }).cards.map((c) => c.item.id)).toEqual(['b']);
  });

  it('New, unseen, removed and listening cards are never in a session; reading and production are', () => {
    const due = ny(10, 8, 6);
    const cards = [
      card('r', due),
      card('r', due, { skill: 'production' }),
      card('r', due, { skill: 'reading' }),
      card('new', due, { state: 'introduced', card: { ...createEmptyCard(due), reps: 0 } as SkillCard['card'] }),
      card('unseen', due, { state: 'unseen' }),
      card('nope', due, { flags: { snoozed: true } }),
      card('listen', due, { skill: 'listening' }),
      { ...card('gram', due), item: { kind: 'grammar' as const, id: 'gram-le' } },
    ];
    const s = reviewStatus({ cards, evidence: [], now: ny(10, 8, 7), settings: S });
    expect(s.sessionCards).toBe(4);
    expect(s.thirstyWords).toBe(1);
    expect(s.thirstyWordIds).toEqual(['r']);
  });

  it('the backlog pause shows only when more is in the session than its cap', () => {
    expect(newWordState({ dueNow: 81, capLeft: 80, cap: 80, baseNew: 6 })).toEqual({
      newState: 'paused_backlog',
      newAllowed: 0,
      newMessage: "New words paused until this session's reviews are done.",
    });
    expect(newWordState({ dueNow: 80, capLeft: 80, cap: 80, baseNew: 6 })).toMatchObject({ newState: 'reduced', newAllowed: 3 });
    expect(newWordState({ dueNow: 10, capLeft: 20, cap: 80, baseNew: 6 })).toEqual({ newState: 'open', newAllowed: 6 });
    expect(newWordState({ dueNow: 0, capLeft: 0, cap: 80, baseNew: 6 }).newState).toBe('limit_reached');
  });
});

describe('time zones and DST (Phase 23)', () => {
  it('a wall-clock time in New York is the same instant on any device', () => {
    expect(ny(10, 8, 16).toISOString()).toBe('2026-10-08T20:00:00.000Z'); // EDT
    expect(ny(12, 8, 16).toISOString()).toBe('2026-12-08T21:00:00.000Z'); // EST
    expect(zonedParts(new Date('2026-10-08T20:00:00Z'), TZ)).toMatchObject({ hour: 16, minute: 0, day: 8 });
  });

  it('fall back (1 Nov 2026): the evening still opens at 4 pm local and covers until 10 am', () => {
    const before = sessionAt(new Date('2026-11-01T05:30:00Z'), S); // 01:30 EDT, inside the 31 Oct evening
    expect(before.current?.name).toBe('evening');
    expect(before.current?.endsAt.toISOString()).toBe('2026-11-01T09:00:00.000Z'); // 04:00 EST
    expect(before.current?.cutoff.toISOString()).toBe('2026-11-01T15:00:00.000Z'); // 10:00 EST
    const at2 = sessionAt(new Date('2026-11-01T19:00:00Z'), S); // 14:00 EST
    expect(at2.current).toBeUndefined();
    expect(at2.next.opensAt.toISOString()).toBe('2026-11-01T21:00:00.000Z'); // 16:00 EST
    const cards = [card('x', new Date('2026-11-01T16:00:00Z'))]; // 11:00 EST
    const s = reviewStatus({ cards, evidence: [], now: new Date('2026-11-01T19:00:00Z'), settings: S });
    expect(s.nextSession).toMatchObject({ name: 'evening', count: 1 });
  });

  it('spring forward (8 Mar 2026): a time in the skipped hour moves forward; sessions keep local times', () => {
    expect(zonedDate(2026, 3, 8, 2, 30, TZ).toISOString()).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    const pos = sessionAt(new Date('2026-03-08T07:30:00Z'), S); // 03:30 EDT
    expect(pos.current?.name).toBe('evening');
    expect(pos.next.opensAt.toISOString()).toBe('2026-03-08T08:00:00.000Z'); // 04:00 EDT
    expect(pos.next.endsAt.toISOString()).toBe('2026-03-08T14:00:00.000Z'); // 10:00 EDT
  });

  it('another zone: Taipei', () => {
    const tp = { ...S, timeZone: 'Asia/Taipei' };
    const pos = sessionAt(new Date('2026-10-08T00:30:00Z'), tp); // 08:30 in Taipei
    expect(pos.current?.name).toBe('morning');
    expect(pos.current?.cutoff.toISOString()).toBe('2026-10-08T08:00:00.000Z'); // 16:00 Taipei
  });

  it('settings are sanitised: bad times, zones and caps fall back', () => {
    expect(sanitizeSessionSettings({ timeZone: 'Mars/Olympus', capPerSession: 5, morningOpens: '9:5' })).toEqual({
      ...DEFAULT_SESSION_SETTINGS,
      capPerSession: 10,
    });
    expect(
      sanitizeSessionSettings({ morningOpens: '6:00', morningEnds: '09:30', eveningOpens: '17:00', eveningEnds: '23:00' }),
    ).toMatchObject({ morningOpens: '06:00', morningEnds: '09:30', eveningOpens: '17:00', eveningEnds: '23:00' });
    // a morning that ends after the evening opens is not a valid day
    expect(sanitizeSessionSettings({ morningEnds: '18:00' }).morningEnds).toBe('10:00');
  });
});

describe('sessionForecast', () => {
  it('two bars a day, morning and evening; overdue cards land in the next session', () => {
    const cards = [
      card('overdue', ny(10, 8, 11)),
      card('eve', ny(10, 8, 18)),
      card('eve2', ny(10, 9, 9)), // before 10:00 tomorrow: tonight's session
      card('m2', ny(10, 9, 12)),
      card('e3', ny(10, 10, 20)),
    ];
    const f = sessionForecast({ cards, evidence: [], now: ny(10, 8, 14), settings: S, days: 3 });
    expect(f).toEqual([
      { day: '2026-10-08', morning: 0, evening: 3 },
      { day: '2026-10-09', morning: 1, evening: 0 },
      { day: '2026-10-10', morning: 0, evening: 1 },
    ]);
  });
});
