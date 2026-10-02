import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCard, type SkillCard } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { migrateLexiconIds } from '../db/migrate.js';
import { AnanDB } from '../db/schema.js';

const BUILD = path.resolve(__dirname, '../../../../data/build');
const v1Ids = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../packages/data-pipeline/src/fixtures/lexicon-v1-ids.json'),
    'utf8',
  ),
) as string[];
const v2 = JSON.parse(readFileSync(path.join(BUILD, 'lexicon.v2.json'), 'utf8')) as {
  words: { id: string }[];
};
const migrationMap = JSON.parse(
  readFileSync(path.join(BUILD, 'id-migration-map.json'), 'utf8'),
) as Record<string, string>;

let db: AnanDB;
beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
});
afterEach(async () => {
  await db.delete();
});

describe('lexicon v1 -> v2 rebuild (phase 7: levels corrected, glosses rebuilt)', () => {
  it('keeps every saved item and evidence row resolvable after migrating with the real id map', async () => {
    const repo = new DexieLearnerRepo(db);
    const now = new Date('2026-03-01');
    // a "learner" who has met every 20th word of the v1 lexicon, in both skills
    const sample = v1Ids.filter((_, i) => i % 20 === 0);
    const cards: SkillCard[] = sample.flatMap((id) =>
      (['recognition', 'production'] as const).map((skill) => ({
        item: { kind: 'word' as const, id },
        skill,
        card: { ...emptyCard(now), stability: 12, reps: 4, state: 2 },
        state: 'review' as const,
        lapses: 1,
        leech: false,
        leechTreatmentsTried: [],
        clozeRung: 2 as const,
        clozeStreak: 1,
        familiarity: 0,
        readingDependence: 0.3,
        flags: {},
        updatedAt: now,
      })),
    );
    await repo.putCards(cards);
    await repo.appendEvidence(
      sample.map((id) => ({
        item: { kind: 'word' as const, id },
        skill: 'recognition' as const,
        kind: 'review_good' as const,
        at: now,
      })),
    );

    await migrateLexiconIds(db, migrationMap);

    const v2Ids = new Set(v2.words.map((w) => w.id));
    const rows = await db.items.toArray();
    expect(rows).toHaveLength(cards.length);
    expect(rows.every((r) => v2Ids.has(r.item.id))).toBe(true);
    expect((await db.evidence.toArray()).every((e) => v2Ids.has(e.item.id))).toBe(true);
    // progress itself is untouched
    expect(rows.every((r) => r.card.stability === 12 && r.lapses === 1 && r.clozeRung === 2)).toBe(
      true,
    );
  });

  it('renames progress when a rebuild does rename an id', async () => {
    const repo = new DexieLearnerRepo(db);
    await repo.putCards([
      {
        item: { kind: 'word', id: 'old-id' },
        skill: 'recognition',
        card: emptyCard(new Date()),
        state: 'learning',
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
        clozeRung: 1,
        clozeStreak: 0,
        familiarity: 0,
        readingDependence: 0,
        flags: {},
        updatedAt: new Date(),
      },
    ]);
    expect(await migrateLexiconIds(db, { 'old-id': 'new-id' })).toBe(1);
    expect((await db.items.toArray()).map((r) => r.item.id)).toEqual(['new-id']);
  });
});
