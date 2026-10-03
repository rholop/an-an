import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCard, type Evidence, type SkillCard } from '@anan/core';
import { BackupSchemaTooNewError, exportBackup, importBackup } from './backup.js';
import { AnanDB, DB_SCHEMA_VERSION } from './schema.js';
import { DexieLearnerRepo } from './learner-repo.js';

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
    card: emptyCard(now),
    state: 'introduced',
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

const evidence: Evidence = {
  item: { kind: 'word', id: 'w1' },
  skill: 'recognition',
  kind: 'review_good',
  at: new Date('2026-01-01'),
};

describe('export -> wipe -> import round-trip', () => {
  it('reproduces identical DB content', async () => {
    await repo.putCards([
      card('w1'),
      card('w2', {
        skill: 'production',
        state: 'mature',
        card: { ...emptyCard(new Date()), stability: 40 },
      }),
    ]);
    await repo.appendEvidence([evidence]);
    await db.settings.put({ key: 'targetRetention', value: 0.9 });
    await db.meta.put({ key: 'lexiconVersion', value: 'v1' });

    const backup = await exportBackup(db, 'v1');

    // wipe
    await Promise.all([
      db.items.clear(),
      db.evidence.clear(),
      db.settings.clear(),
      db.meta.clear(),
    ]);
    expect(await db.items.count()).toBe(0);

    const result = await importBackup(db, JSON.parse(JSON.stringify(backup)));
    expect(result.itemCount).toBe(2);
    expect(result.evidenceCount).toBe(1);

    const itemsAfter = await db.items.toArray();
    const w1 = itemsAfter.find((i) => i.item.id === 'w1' && i.skill === 'recognition');
    const w2 = itemsAfter.find((i) => i.item.id === 'w2' && i.skill === 'production');
    expect(w1?.state).toBe('introduced');
    expect(w2?.state).toBe('mature');
    expect(w2?.card.stability).toBe(40);
    expect(w2?.card.due).toBeInstanceOf(Date); // revived from the JSON round-trip, not left a string

    const settingsAfter = await db.settings.toArray();
    expect(settingsAfter).toMatchObject([{ key: 'targetRetention', value: 0.9 }]);
    expect(settingsAfter[0]!.updatedAt).toBeInstanceOf(Date); // phase 8: stamped, and kept through the round trip

    const evidenceAfter = await db.evidence.toArray();
    expect(evidenceAfter).toHaveLength(1);
    expect(evidenceAfter[0]!.at).toBeInstanceOf(Date);
  });
});

describe('importBackup validation', () => {
  it('rejects malformed input instead of silently importing garbage', async () => {
    await expect(importBackup(db, { not: 'a backup' })).rejects.toThrow();
    expect(await db.items.count()).toBe(0);
  });

  it('refuses a backup from a newer schema version than this app supports', async () => {
    const future = await exportBackup(db);
    future.schemaVersion = DB_SCHEMA_VERSION + 1;
    await expect(importBackup(db, JSON.parse(JSON.stringify(future)))).rejects.toThrow(
      BackupSchemaTooNewError,
    );
  });

  it('accepts a backup at exactly the current schema version', async () => {
    const current = await exportBackup(db);
    await expect(importBackup(db, JSON.parse(JSON.stringify(current)))).resolves.toBeDefined();
  });
});

describe('reader tables (phase 9)', () => {
  const live = {
    id: 'live-1',
    zh: '我去便利商店',
    en: 'I go to the shop',
    targetWordId: 'w1',
    level: 'N2' as const,
    tokens: [],
    source: 'generated-live' as const,
    doubtful: false,
    createdAt: new Date('2026-03-01T10:00:00Z'),
  };

  it('live sentences and shown history survive an export/import round trip', async () => {
    await db.liveSentences.put(live);
    await db.readerShown.put({ sentenceId: 'live-1', at: new Date('2026-03-02T10:00:00Z') });
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    expect(backup.schemaVersion).toBe(DB_SCHEMA_VERSION);

    await db.liveSentences.clear();
    await db.readerShown.clear();
    await importBackup(db, backup);

    expect(await db.liveSentences.toArray()).toEqual([live]);
    const shown = await db.readerShown.toArray();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.at).toEqual(new Date('2026-03-02T10:00:00Z'));
  });

  it('a backup from before phase 9 (no reader fields) still imports', async () => {
    const old = JSON.parse(JSON.stringify(await exportBackup(db)));
    delete old.liveSentences;
    delete old.readerShown;
    old.schemaVersion = 5;
    await expect(importBackup(db, old)).resolves.toBeDefined();
    expect(await db.liveSentences.count()).toBe(0);
  });

  it('rejects a live sentence whose source is not generated-live', async () => {
    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    backup.liveSentences = [{ ...live, source: 'generated', createdAt: live.createdAt.toISOString() }];
    await expect(importBackup(db, backup)).rejects.toThrow();
  });
});
