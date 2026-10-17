// Phase 45: practice answers through the app's learner service: a practice-only answer never moves
// a card (no short-step parking, no unlock), a practice Again only sets priority; a practice round
// takes cards not practised yet first, 20 at most, in the ledger's order.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence, SkillCard } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';
import { practiceRound } from '../pages/PracticePage.js';

let db: AnanDB;
let service: LearnerService;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  service = new LearnerService(new DexieLearnerRepo(db));
});

afterEach(async () => {
  await db.delete();
});

const item = { kind: 'word' as const, id: 'w1' };
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 10, h, m));

describe('practice answers in the learner service', () => {
  it('practice_* leaves a card in its learning step where it is; Again only adds priority', async () => {
    // one Again in Review: the card is in a short learning step
    const before = (await service.record({ item, skill: 'recognition', kind: 'review_again', at: at(12) }, at(12)))!;
    for (const kind of ['practice_good', 'practice_easy', 'practice_hard'] as const) {
      const e: Evidence = { item, skill: 'recognition', kind, at: at(12, 1), context: { source: 'review', practice: true } };
      await service.record(e, at(12, 1));
    }
    expect(await service.getCard(item, 'recognition')).toEqual(before);
    await service.record({ item, skill: 'recognition', kind: 'practice_again', at: at(12, 2), context: { source: 'review', practice: true } }, at(12, 2));
    const marked = (await service.getCard(item, 'recognition'))!;
    expect(marked.flags.priority).toBe(true);
    expect(marked.card).toEqual(before.card);
    expect(await service.getCard(item, 'production')).toBeUndefined();
    // every answer is in the log
    expect((await db.evidence.toArray()).filter((e) => e.kind.startsWith('practice_'))).toHaveLength(4);
  });

  it('a practice Again can be undone', async () => {
    await service.record({ item, skill: 'recognition', kind: 'review_good', at: at(12) }, at(12));
    const h = await service.recordUndoable({ item, skill: 'recognition', kind: 'practice_again', at: at(13), context: { source: 'review', practice: true } }, at(13));
    expect(h.card?.flags.priority).toBe(true);
    await h.undo();
    expect((await service.getCard(item, 'recognition'))!.flags.priority).toBeUndefined();
  });
});

describe('practiceRound', () => {
  const card = (id: string): SkillCard => ({ item: { kind: 'word', id }, skill: 'recognition' }) as SkillCard;
  const all = Array.from({ length: 30 }, (_, i) => card(`w${i}`));
  it('takes 20 cards in order, then the ones not practised yet first', () => {
    const first = practiceRound(all, new Set());
    expect(first.map((c) => c.item.id)).toEqual(all.slice(0, 20).map((c) => c.item.id));
    const done = new Set(first.map((c) => `word:${c.item.id}|recognition`));
    const second = practiceRound(all, done);
    expect(second).toHaveLength(20);
    // the 10 not practised yet, topped up with 10 practised ones, shown in the ledger's order
    expect(second.map((c) => c.item.id)).toEqual(all.slice(0, 10).map((c) => c.item.id).concat(all.slice(20).map((c) => c.item.id)));
  });
});
