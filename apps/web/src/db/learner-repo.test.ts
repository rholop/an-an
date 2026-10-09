import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCard, type SkillCard } from '@anan/core';
import { DexieLearnerRepo } from './learner-repo.js';
import { AnanDB } from './schema.js';

let db: AnanDB;
let repo: DexieLearnerRepo;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  repo = new DexieLearnerRepo(db);
});

afterEach(async () => {
  await db.delete();
});

function card(id: string, overrides: Partial<SkillCard> = {}): SkillCard {
  const now = new Date('2026-01-01');
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...emptyCard(now), reps: 1 },
    state: 'learning',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
    ...overrides,
  };
}

describe('DexieLearnerRepo', () => {
  it('getCard returns undefined for an item never stored', async () => {
    expect(await repo.getCard({ kind: 'word', id: 'nope' }, 'recognition')).toBeUndefined();
  });

  it('putCards then getCard round-trips the exact card', async () => {
    const c = card('w1');
    await repo.putCards([c]);
    const fetched = await repo.getCard({ kind: 'word', id: 'w1' }, 'recognition');
    expect(fetched).toEqual(c);
  });

  it('keeps recognition and production as separate cards for the same item', async () => {
    await repo.putCards([card('w1', { skill: 'recognition' }), card('w1', { skill: 'production' })]);
    const rec = await repo.getCard({ kind: 'word', id: 'w1' }, 'recognition');
    const prod = await repo.getCard({ kind: 'word', id: 'w1' }, 'production');
    expect(rec?.skill).toBe('recognition');
    expect(prod?.skill).toBe('production');
  });

  it('appendEvidence is append-only and queryable', async () => {
    await repo.appendEvidence([
      { item: { kind: 'word', id: 'w1' }, skill: 'recognition', kind: 'review_good', at: new Date('2026-01-01') },
    ]);
    const rows = await db.evidence.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('review_good');
  });

  it('allCards returns every stored card', async () => {
    await repo.putCards([card('a', { state: 'unseen' }), card('b', { state: 'mature' })]);
    expect((await repo.allCards()).length).toBe(2);
  });

});
