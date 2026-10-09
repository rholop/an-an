import { describe, expect, it } from 'vitest';
import { applyEvidence } from './apply-evidence.js';
import { emptyCard } from './fsrs-instance.js';
import {
  capDueCards,
  cardSourceFor,
  cleanupGroupWordIds,
  isActiveCard,
  lookupMayIntroduce,
  newItemInBounds,
  pileReport,
  shouldWake,
  spreadBulkDue,
} from './review-pile.js';
import type { SkillCard } from './types.js';
import type { Evidence, Word } from '../types.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const DAY = 86_400_000;

const w = (id: string, over: Partial<Word> = {}): Word => ({
  id,
  headword: id,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [id],
  tags: [],
  ...over,
});

const ev = (kind: Evidence['kind'], extra: Partial<Evidence> = {}): Evidence => ({
  item: { kind: 'word', id: 'w1' },
  skill: 'recognition',
  kind,
  at: NOW,
  ...extra,
});

function reviewCard(id: string, over: { stability?: number; lastDaysAgo?: number } = {}): SkillCard {
  const last = new Date(NOW.getTime() - (over.lastDaysAgo ?? 5) * DAY);
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...emptyCard(last), state: 2, reps: 3, stability: over.stability ?? 5, last_review: last, due: last },
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: last,
  };
}

describe('Nope', () => {
  const base = reviewCard('w1', { stability: 4 });

  it('Not now: flags only, remembers where the learner was; not a lapse, no rating', () => {
    const r = applyEvidence(base, ev('review_nope', { context: { source: 'review', choice: 'not_now', snoozedWhen: { level: 'N1' } } }), NOW);
    expect(r.card!.flags).toMatchObject({ snoozed: true, snoozedWhen: { level: 'N1' } });
    expect(r.card!.card).toEqual(base.card);
    expect(r.card!.lapses).toBe(0);
    expect(isActiveCard(r.card!)).toBe(false);
  });

  it('I already know it: scheduled 60 days out, marked known, still not a lapse', () => {
    const r = applyEvidence(base, ev('review_nope', { context: { source: 'review', choice: 'known' } }), NOW);
    expect(r.card!.flags.markedKnown).toBe(true);
    expect(new Date(r.card!.card.due).getTime()).toBe(NOW.getTime() + 60 * DAY);
    expect(r.card!.card.stability).toBeGreaterThanOrEqual(60);
    expect(r.card!.lapses).toBe(0);
    expect(r.card!.state).toBe('mature');
    expect(isActiveCard(r.card!)).toBe(true);
  });

  it('Never show: excluded', () => {
    const r = applyEvidence(base, ev('review_nope', { context: { source: 'review', choice: 'never' } }), NOW);
    expect(r.card!.flags.excluded).toBe(true);
    expect(isActiveCard(r.card!)).toBe(false);
  });

  it('Restore clears every removal; "Add to review" introduces a word with no card', () => {
    const never = applyEvidence(base, ev('review_nope', { context: { source: 'review', choice: 'never' } }), NOW).card!;
    const back = applyEvidence(never, ev('review_restore'), NOW).card!;
    expect(isActiveCard(back)).toBe(true);
    expect(back.flags.excluded).toBeUndefined();
    const added = applyEvidence(undefined, ev('review_restore'), NOW).card!;
    expect(added.state).toBe('introduced');
    expect(added.source).toBe('added');
  });
});

describe('daily cap and new-card pause', () => {
  it('300 due → a session of at most 80, study-order cards first', () => {
    const due = Array.from({ length: 300 }, (_, i) => reviewCard(`w${i}`));
    const lesson = new Set(Array.from({ length: 30 }, (_, i) => `w${i * 10}`));
    const picked = capDueCards(due, { remaining: 80, now: NOW, rank: (c) => (lesson.has(c.item.id) ? 0 : 1) });
    expect(picked).toHaveLength(80);
    expect(picked.slice(0, 30).every((c) => lesson.has(c.item.id))).toBe(true);
  });

  it('after the study order, the cards most likely forgotten go first', () => {
    const fresh = reviewCard('fresh', { stability: 30, lastDaysAgo: 2 });
    const overdue = reviewCard('overdue', { stability: 2, lastDaysAgo: 20 });
    expect(capDueCards([fresh, overdue], { remaining: 1, now: NOW })[0]!.item.id).toBe('overdue');
  });

});

describe('bulk spread', () => {
  it('a 3,000-card Anki import never puts more than the cap on one day', () => {
    const cards = Array.from({ length: 3000 }, (_, i) =>
      applyEvidence(undefined, { ...ev('anki_import_seen'), item: { kind: 'word', id: `w${i}` } }, NOW).card!,
    );
    const spread = spreadBulkDue(cards, NOW, { cap: 80 });
    const perDay = new Map<string, number>();
    for (const c of spread) {
      const d = new Date(c.card.due).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(80);
    // and it really is spread out (a 2–4 week window at least)
    expect(perDay.size).toBeGreaterThanOrEqual(14);
  });

  it('a small import is still spread over 2–4 weeks', () => {
    const cards = Array.from({ length: 50 }, (_, i) => reviewCard(`w${i}`));
    const days = new Set(spreadBulkDue(cards, NOW).map((c) => new Date(c.card.due).toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(14);
    expect(days.size).toBeLessThanOrEqual(28);
  });
});

describe('bounds', () => {
  it('lookups introduce only TOCFL words up to the picked level + 1, and textbook/own words', () => {
    expect(lookupMayIntroduce(w('a', { level: 'N2' }), 'N1')).toBe(true);
    expect(lookupMayIntroduce(w('a', { level: 'L3' }), 'N1')).toBe(false);
    expect(lookupMayIntroduce(w('a', { level: null, source: 'supplement', tags: ['compound:moe'] }), 'N1')).toBe(false);
    expect(lookupMayIntroduce(w('a', { tags: ['name'] }), 'N1')).toBe(false);
    expect(lookupMayIntroduce(w('a', { level: 'L2', tags: ['textbook:laixue-1'] }), 'N1')).toBe(true);
    expect(lookupMayIntroduce(w('a', { level: null, source: 'custom' }), 'N1')).toBe(true);
  });

  it('new items never come from supplementary entries or names', () => {
    expect(newItemInBounds(w('a'))).toBe(true);
    expect(newItemInBounds(w('a', { level: null, source: 'supplement' }))).toBe(false);
    expect(newItemInBounds(w('a', { level: 'L1', source: 'supplement' }))).toBe(false);
    expect(newItemInBounds(w('a', { tags: ['name'] }))).toBe(false);
  });

  it('an out-of-bounds lookup is logged without making a card', () => {
    const r = applyEvidence(undefined, ev('chat_lookup_gloss', { context: { source: 'chat', noIntroduce: true } }), NOW);
    expect(r.card).toBeUndefined();
  });
});

describe('Not now wakes only when its level or lesson becomes active', () => {
  const snoozed = { flags: { snoozed: true, snoozedWhen: { level: 'N1' as const } } };
  it('not while the learner is still where they were', () => {
    expect(shouldWake(snoozed, { level: 'N1' }, { level: 'N1' })).toBe(false);
    expect(shouldWake(snoozed, { level: 'L2' }, { level: 'N2' })).toBe(false);
  });
  it('when the picked level becomes the word’s level, or its lesson becomes the active step', () => {
    expect(shouldWake(snoozed, { level: 'L2' }, { level: 'L2' })).toBe(true);
    expect(shouldWake(snoozed, { level: 'L2', lessonId: 'laixue-2-L03' }, { level: 'N1', activeLessonId: 'laixue-2-L03' })).toBe(true);
  });
});

describe('pile report', () => {
  it('counts by source and level, and clean-up groups pick the matching words', () => {
    const lex = new Map<string, Word>([
      ['a', w('a', { level: 'N1' })],
      ['b', w('b', { level: 'L4' })],
      ['c', w('c', { level: null, source: 'supplement' })],
    ]);
    const cards = [
      { ...reviewCard('a'), source: 'anki' as const },
      { ...reviewCard('b'), source: 'chat_lookup' as const },
      { ...reviewCard('c'), source: 'chat_leak' as const },
    ];
    const r = pileReport(cards, (id) => lex.get(id), 'N1');
    expect(r.bySource).toMatchObject({ anki: 1, chat_lookup: 1, chat_leak: 1 });
    expect(r.aboveLevel).toBe(1);
    expect(r.notInAnyList).toBe(1);
    expect(cleanupGroupWordIds(r, { kind: 'above_level' })).toEqual(['b']);
    expect(cleanupGroupWordIds(r, { kind: 'no_list' })).toEqual(['c']);
    expect(cleanupGroupWordIds(r, { kind: 'source', source: 'anki' })).toEqual(['a']);
  });

  it('cardSourceFor maps evidence to where a card came from', () => {
    expect(cardSourceFor(ev('anki_import_seen'))).toBe('anki');
    expect(cardSourceFor(ev('chat_lookup_gloss', { context: { source: 'reader' } }))).toBe('reader_lookup');
    expect(cardSourceFor(ev('chat_lookup_gloss', { context: { source: 'chat', refId: 'validator-leak' } }))).toBe('chat_leak');
  });
});
