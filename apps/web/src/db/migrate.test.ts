import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCard, type SkillCard } from '@anan/core';
import { DexieLearnerRepo } from './learner-repo.js';
import { migrateLexiconIds } from './migrate.js';
import { AnanDB, itemPk } from './schema.js';

let db: AnanDB;
let repo: DexieLearnerRepo;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  repo = new DexieLearnerRepo(db);
});

afterEach(async () => {
  await db.delete();
});

function card(id: string): SkillCard {
  const now = new Date('2026-01-01');
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: emptyCard(now),
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}

describe('migrateLexiconIds', () => {
  it('is a no-op on an empty map', async () => {
    await repo.putCards([card('old-id')]);
    const changed = await migrateLexiconIds(db, {});
    expect(changed).toBe(0);
    expect(await repo.getCard({ kind: 'word', id: 'old-id' }, 'recognition')).toBeDefined();
  });

  it('renames an item id in both items and evidence, preserving all other data', async () => {
    await repo.putCards([card('old-id')]);
    await repo.appendEvidence([
      { item: { kind: 'word', id: 'old-id' }, skill: 'recognition', kind: 'review_good', at: new Date('2026-01-01') },
    ]);

    const changed = await migrateLexiconIds(db, { 'old-id': 'new-id' });
    expect(changed).toBe(1);

    expect(await repo.getCard({ kind: 'word', id: 'old-id' }, 'recognition')).toBeUndefined();
    const migrated = await repo.getCard({ kind: 'word', id: 'new-id' }, 'recognition');
    expect(migrated?.state).toBe('review');

    const evidenceRows = await db.evidence.toArray();
    expect(evidenceRows[0]!.item.id).toBe('new-id');
  });

  it('updates the primary key so the row is reachable under the new id', async () => {
    await repo.putCards([card('old-id')]);
    await migrateLexiconIds(db, { 'old-id': 'new-id' });
    const row = await db.items.get(itemPk({ kind: 'word', id: 'new-id' }, 'recognition'));
    expect(row).toBeDefined();
  });

  it('leaves ids not present in the map untouched', async () => {
    await repo.putCards([card('keep-me')]);
    await migrateLexiconIds(db, { 'some-other-id': 'whatever' });
    expect(await repo.getCard({ kind: 'word', id: 'keep-me' }, 'recognition')).toBeDefined();
  });
});
