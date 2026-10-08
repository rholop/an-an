import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeEvidence, emptyCard, pileReport, type SkillCard, type Word } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService, setLookupGate } from './learner-service.js';
import { applyCleanup, cleanupPreview, removedWords } from './review-cleanup.js';
import { pickReviewCards } from './review-session.js';

let db: AnanDB;
let repo: DexieLearnerRepo;
let service: LearnerService;
const NOW = new Date('2026-10-07T12:00:00Z');
const stripStamp = ({ updatedAt: _u, ...rest }: SkillCard) => rest;
const DAY = 86_400_000;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  repo = new DexieLearnerRepo(db);
  service = new LearnerService(repo);
});
afterEach(async () => {
  setLookupGate(undefined);
  await db.delete();
});

const word = (id: string, level: Word['level'], over: Partial<Word> = {}): Word => ({
  id,
  headword: `字${id}`,
  variants: [],
  pos: ['N'],
  level,
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: ['字'],
  tags: [],
  ...over,
});

const card = (id: string, skill: SkillCard['skill'], dueDaysAgo = 1): SkillCard => {
  const due = new Date(NOW.getTime() - dueDaysAgo * DAY);
  return {
    item: { kind: 'word', id },
    skill,
    card: { ...emptyCard(due), state: 2, reps: 3, stability: 4, last_review: new Date(due.getTime() - 4 * DAY), due },
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    source: 'chat_lookup',
    updatedAt: due,
  };
};

describe('Nope in the app (Phase 20)', () => {
  it('one call removes every skill of the word; Undo restores each card exactly', async () => {
    const before = [card('w1', 'recognition'), card('w1', 'production'), card('w1', 'listening')];
    await repo.putCards(before);
    const h = await service.nope({ kind: 'word', id: 'w1' }, 'not_now', {}, NOW);
    expect(await repo.dueCards(NOW, 100)).toHaveLength(0);
    expect(await repo.dueListeningCards(NOW, 100)).toHaveLength(0);
    await h.undo();
    // Phase 21: restored exactly apart from a new updatedAt (sync-safe undo); no active evidence left.
    expect((await repo.cardsOfItem({ kind: 'word', id: 'w1' })).map(stripStamp)).toEqual(before.map(stripStamp));
    expect(activeEvidence(await db.evidence.toArray())).toHaveLength(0);
  });

  it('Never show keeps the word out of the due queue; I already know it counts as known', async () => {
    await repo.putCards([card('a', 'recognition'), card('b', 'recognition')]);
    await service.nope({ kind: 'word', id: 'a' }, 'never', {}, NOW);
    await service.nope({ kind: 'word', id: 'b' }, 'known', {}, NOW);
    expect(await repo.dueCards(NOW, 100)).toHaveLength(0);
    expect((await service.wordSets(NOW)).knownIds.has('b')).toBe(true);
    // Restore brings "never" back
    await service.restore({ kind: 'word', id: 'a' }, NOW);
    expect((await repo.dueCards(NOW, 100)).map((c) => c.item.id)).toEqual(['a']);
  });
});

describe('daily cap (Phase 20)', () => {
  it('300 cards due: a session of at most 80, and no new cards that day', () => {
    const due = Array.from({ length: 300 }, (_, i) => card(`w${i}`, 'recognition'));
    const r = pickReviewCards({ due, doneThisSession: 0, cap: 80, now: NOW });
    expect(r.due).toHaveLength(80);
    expect(r.held).toBe(220);
    expect(r.newItems).toHaveLength(0);
    expect(r.newPaused).toBe(true);
  });

  it('reviews already done today count toward the cap', () => {
    const due = Array.from({ length: 50 }, (_, i) => card(`w${i}`, 'recognition'));
    expect(pickReviewCards({ due, doneThisSession: 60, cap: 80, now: NOW }).due).toHaveLength(20);
  });
});

describe('Anki import spread (Phase 20)', () => {
  it('a 3,000-word import puts no more than the cap on any day', async () => {
    const events = Array.from({ length: 3000 }, (_, i) => ({
      item: { kind: 'word' as const, id: `w${i}` },
      skill: 'recognition' as const,
      kind: 'anki_import_seen' as const,
      at: NOW,
    }));
    await service.recordBulk(events, NOW);
    const perDay = new Map<string, number>();
    for (const r of await db.items.toArray()) {
      const d = new Date(r.card.due).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(80);
  });
});

describe('lookups (Phase 20)', () => {
  const lex = new Map([['easy', word('easy', 'N1')], ['hard', word('hard', 'L5')]]);
  it('an out-of-level lookup makes no card; Add to review does', async () => {
    setLookupGate((id) => (lex.get(id)?.level ?? 'N1') !== 'L5');
    const lookup = (id: string) =>
      service.record({ item: { kind: 'word', id }, skill: 'recognition', kind: 'chat_lookup_gloss', at: NOW, context: { source: 'chat' } }, NOW);
    expect(await lookup('easy')).toBeDefined();
    expect(await lookup('hard')).toBeUndefined();
    expect(await service.getCard({ kind: 'word', id: 'hard' }, 'recognition')).toBeUndefined();
    await service.restore({ kind: 'word', id: 'hard' }, NOW);
    expect((await service.getCard({ kind: 'word', id: 'hard' }, 'recognition'))?.state).toBe('introduced');
  });
});

describe('bulk clean-up (Phase 20)', () => {
  it('preview count matches what is removed, and Undo restores them all', async () => {
    const lex = new Map<string, Word>();
    const cards: SkillCard[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `w${i}`;
      lex.set(id, word(id, i < 12 ? 'L4' : 'N1'));
      cards.push(card(id, 'recognition'), card(id, 'production'));
    }
    await repo.putCards(cards);
    const before = await repo.allCards();
    const report = pileReport(before, (id) => lex.get(id), 'N1');
    const preview = cleanupPreview(report, { kind: 'above_level' });
    expect(preview.ids).toHaveLength(12);
    expect(preview.sample).toHaveLength(10);
    const done = await applyCleanup(service, preview.ids, {}, NOW);
    expect(done.count).toBe(12);
    expect(removedWords(await repo.allCards())).toHaveLength(12);
    expect(new Set((await repo.dueCards(NOW, 1000)).map((c) => c.item.id)).size).toBe(18);
    await done.undo();
    const after = await repo.allCards();
    const sort = (xs: SkillCard[]) => [...xs].sort((a, b) => `${a.item.id}${a.skill}`.localeCompare(`${b.item.id}${b.skill}`));
    expect(sort(after).map(stripStamp)).toEqual(sort(before).map(stripStamp));
  });
});
