import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';
import { endOfDay, newWordState, reviewForecast, reviewStatus } from './review-status.js';

const NOW = new Date(2026, 9, 8, 9, 44); // 9:44 am local, like the owner's screenshot
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 8 + dayOffset, h, m);

function card(id: string, due: Date, over: Partial<SkillCard> = {}): SkillCard {
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...createEmptyCard(at(0, 0, -10)), due, reps: 2, stability: 5 },
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: at(0),
    ...over,
  };
}

const review = (
  id: string,
  kind: Evidence['kind'],
  when: Date,
  skill: Evidence['skill'] = 'recognition',
): Evidence => ({
  item: { kind: 'word', id },
  skill,
  kind,
  at: when,
});

describe('reviewStatus (Phase 22 Part A)', () => {
  it("the owner's scenario: 0 due now, 3 later today, 85 reviews done → today's limit, not a backlog", () => {
    const cards = [
      card('a', at(15, 40)),
      card('b', at(17)),
      card('c', at(21, 5)),
      card('d', at(10, 0, 1)),
    ];
    const evidence = Array.from({ length: 85 }, (_, i) =>
      review(`done-${i}`, 'review_good', at(8, 0)),
    );
    const s = reviewStatus({ cards, evidence, now: NOW, cap: 80, baseNew: 5 });
    expect(s.dueNow).toBe(0);
    expect(s.laterToday).toBe(3);
    expect(s.nextDueAt).toEqual(at(15, 40));
    expect(s.doneToday).toBe(85);
    expect(s.capLeft).toBe(0);
    expect(s.newState).toBe('limit_reached');
    expect(s.newMessage).toBe("You've done today's 80 reviews. New words return tomorrow.");
    expect(s.newMessage).not.toContain('catch up');
    expect(s.reviewAll).toBe(0);
  });

  it('Again repeats of the same card count once toward doneToday', () => {
    const evidence = [
      review('a', 'review_again', at(8)),
      review('a', 'review_again', at(8, 5)),
      review('a', 'review_good', at(8, 10)),
      review('a', 'review_good', at(8, 11), 'production'),
      review('b', 'review_hard', at(9)),
      review('old', 'review_good', at(20, 0, -1)), // yesterday
      review('c', 'cloze_correct_nohint', at(9)), // not a review answer
    ];
    expect(reviewStatus({ cards: [], evidence, now: NOW, cap: 80 }).doneToday).toBe(3);
  });

  it('due now never mixes with later today; New, unseen, removed and listening cards are never due', () => {
    const cards = [
      card('due1', at(7)),
      card('due2', at(0, 0, -3)),
      card('due2', at(9), { skill: 'production' }),
      card('later', at(12)),
      card('new', at(7), { state: 'introduced', card: { ...createEmptyCard(at(7)), reps: 0 } }),
      card('unseen', at(7), { state: 'unseen' }),
      card('nope', at(7), { flags: { snoozed: true } }),
      card('nope2', at(12), { flags: { excluded: true } }),
      card('listen', at(7), { skill: 'listening' }),
      { ...card('gram', at(8)), item: { kind: 'grammar', id: 'gram-le' } },
    ];
    const s = reviewStatus({ cards, evidence: [], now: NOW, cap: 80 });
    expect(s.dueNow).toBe(4);
    expect(s.laterToday).toBe(1);
    // Water all counts words (a word's two due cards are one plant); grammar isn't in the garden.
    expect(s.thirstyWords).toBe(2);
    expect(s.thirstyWordIds.sort()).toEqual(['due1', 'due2']);
    expect(s.reviewAll).toBe(4);
  });

  it('Review all is capped by what is left of the daily cap', () => {
    const cards = Array.from({ length: 30 }, (_, i) => card(`w${i}`, at(6)));
    const evidence = Array.from({ length: 70 }, (_, i) => review(`d${i}`, 'review_good', at(7)));
    const s = reviewStatus({ cards, evidence, now: NOW, cap: 80 });
    expect(s.capLeft).toBe(10);
    expect(s.reviewAll).toBe(10);
  });

  it('the backlog pause shows only when more is due now than the cap', () => {
    expect(newWordState({ dueNow: 81, capLeft: 80, cap: 80, baseNew: 6 })).toEqual({
      newState: 'paused_backlog',
      newAllowed: 0,
      newMessage: 'New words paused until your reviews catch up.',
    });
    expect(newWordState({ dueNow: 80, capLeft: 80, cap: 80, baseNew: 6 })).toMatchObject({
      newState: 'reduced',
      newAllowed: 3,
    });
    expect(newWordState({ dueNow: 10, capLeft: 20, cap: 80, baseNew: 6 })).toEqual({
      newState: 'open',
      newAllowed: 6,
    });
    // Reviews already done today never make it a "backlog".
    expect(newWordState({ dueNow: 0, capLeft: 0, cap: 80, baseNew: 6 }).newState).toBe(
      'limit_reached',
    );
  });
});

describe('reviewForecast', () => {
  it('first bar is the rest of today, excluding cards due now', () => {
    const cards = [
      card('now', at(8)),
      card('later', at(15)),
      card('later2', at(23, 59)),
      card('tmr', at(1, 0, 1)),
      card('d3', at(12, 0, 2)),
    ];
    expect(reviewForecast(cards, NOW, 4)).toEqual([2, 1, 1, 0]);
  });

  it('endOfDay is local midnight', () => {
    expect(endOfDay(NOW)).toEqual(at(0, 0, 1));
  });
});
