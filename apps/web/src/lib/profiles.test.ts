import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILES, PROFILE_IDS, isProfileId } from '../profiles.js';
import {
  closeSession,
  currentSession,
  db,
  gameService,
  learnerService,
  openSession,
  profileDbName,
} from '../db/instance.js';
import { AnanDB } from '../db/schema.js';
import { peekCurrentLevel, setCurrentLevel } from './current-level.js';
import {
  LEGACY_DB_NAME,
  LegacyMigrationError,
  legacyDbExists,
  migrateLegacyInto,
} from './legacy-migration.js';

const now = new Date('2026-03-01T10:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  closeSession();
  await Promise.all([
    ...PROFILE_IDS.map((id) => Dexie.delete(profileDbName(id))),
    Dexie.delete(LEGACY_DB_NAME),
  ]);
});
afterEach(async () => {
  closeSession();
  await Promise.all([
    ...PROFILE_IDS.map((id) => Dexie.delete(profileDbName(id))),
    Dexie.delete(LEGACY_DB_NAME),
  ]);
});

describe('profiles config', () => {
  it('is the two fixed household profiles with ASCII ids', () => {
    expect(PROFILES).toEqual([
      { id: 'ron', name: '羅恩' },
      { id: 'guanyu', name: '冠宇' },
    ]);
    expect(PROFILES.every((p) => /^[a-z0-9]+$/.test(p.id))).toBe(true);
    expect(isProfileId('ron')).toBe(true);
    expect(isProfileId('RON')).toBe(false);
    expect(profileDbName('guanyu')).toBe('anan-guanyu');
  });
});

describe('one database per profile', () => {
  it('level, settings and game state are independent per profile, and survive switching back', async () => {
    openSession('ron');
    await setCurrentLevel('L3');
    await db.settings.put({ key: 'readerMode', value: 'zhuyin' });
    await gameService.onErrorFixed('e1', now);
    await learnerService.record(
      { item: { kind: 'word', id: 'w-ron' }, skill: 'recognition', kind: 'review_good', at: now },
      now,
    );
    expect(peekCurrentLevel()).toEqual({ level: 'L3', isExplicit: true });

    openSession('guanyu');
    await sleep(20); // the level store reloads from the new profile's database
    expect(peekCurrentLevel().isExplicit).toBe(false); // 冠宇 hasn't chosen anything
    expect(peekCurrentLevel().level).toBe('N1');
    expect(await db.settings.toArray()).toEqual([]);
    expect(await gameService.allRewards()).toEqual([]);
    expect(await db.items.count()).toBe(0);
    expect(await db.evidence.count()).toBe(0);
    await setCurrentLevel('L1');
    await db.settings.put({ key: 'readerMode', value: 'always' });

    openSession('ron');
    await sleep(20);
    expect(peekCurrentLevel()).toEqual({ level: 'L3', isExplicit: true });
    expect((await db.settings.get('readerMode'))?.value).toBe('zhuyin');
    expect((await gameService.allRewards()).map((r) => r.kind).sort()).toEqual([
      'error_fixed',
      'recall_correct',
    ]);
    expect((await db.items.toArray()).map((r) => r.item.id)).toEqual(['w-ron']);

    openSession('guanyu');
    await sleep(20);
    expect(peekCurrentLevel()).toEqual({ level: 'L1', isExplicit: true });
    expect((await db.settings.get('readerMode'))?.value).toBe('always');
  });

  it('each profile lives in its own named Dexie database', async () => {
    openSession('ron');
    await db.settings.put({ key: 'k', value: 1 });
    openSession('guanyu');
    expect(currentSession()?.db.name).toBe('anan-guanyu');
    expect((await Dexie.getDatabaseNames()).sort()).toEqual(expect.arrayContaining(['anan-ron']));
    expect(await new AnanDB('anan-ron').settings.count()).toBe(1);
  });

  it('refuses to touch the data before a profile is open', () => {
    closeSession();
    expect(() => db.items).toThrow(/No profile is open/);
  });
});

/** The pre-phase-8 database exactly as the last release created it (schema v4, no uid/updatedAt). */
async function seedLegacy(): Promise<void> {
  const old = new Dexie(LEGACY_DB_NAME);
  old.version(1).stores({
    items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
    evidence: '++id, at, [item.id], kind',
    settings: 'key',
    meta: 'key',
    customWords: 'id, headword',
    conversations: '++id, scenarioId, startedAt',
    turns: '++id, conversationId, at',
  });
  old
    .version(2)
    .stores({
      journalEntries: 'id, createdAt, status',
      journalReviews: 'entryId, createdAt',
      errorItems: 'id, journalEntryId, card.due, pattern',
    });
  old.version(3).stores({ rewardEvents: 'id, at, kind' });
  old.version(4).stores({ glossReports: '++id, wordId, at', aiGlosses: 'key, at' });
  await old.open();
  const card = {
    due: now,
    stability: 7,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 7,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
  };
  await old.table('items').bulkPut(
    ['a', 'b', 'c'].map((id) => ({
      pk: `word:${id}:recognition`,
      item: { kind: 'word', id },
      skill: 'recognition',
      card,
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
    })),
  );
  await old
    .table('evidence')
    .bulkAdd(
      ['a', 'b', 'c'].map((id) => ({
        item: { kind: 'word', id },
        skill: 'recognition',
        kind: 'review_good',
        at: now,
      })),
    );
  await old.table('settings').put({ key: 'currentLevel', value: 'L2' });
  const conv = (await old
    .table('conversations')
    .add({
      scenarioId: 'tea',
      npcId: 'n',
      startedAt: now,
      goalStepsDone: ['order'],
      completed: true,
      stuckCount: 0,
      englishFallbackUsed: false,
    })) as number;
  await old.table('turns').bulkAdd([
    { conversationId: conv, role: 'npc', zh: '歡迎光臨', at: now },
    { conversationId: conv, role: 'learner', zh: '我要茶', at: new Date(now.getTime() + 1000) },
  ]);
  old.close();
}

describe('migrating the old single database (phase 8 §3)', () => {
  it('copies everything into the chosen profile, then deletes the old database', async () => {
    await seedLegacy();
    expect(await legacyDbExists()).toBe(true);

    const { db: target } = openSession('guanyu');
    const result = await migrateLegacyInto(target);

    expect(result).toEqual({ items: 3, evidence: 3 });
    expect((await target.items.toArray()).map((r) => r.item.id).sort()).toEqual(['a', 'b', 'c']);
    expect(await target.evidence.count()).toBe(3);
    expect((await target.settings.get('currentLevel'))?.value).toBe('L2');
    const [conv] = await target.conversations.toArray();
    expect(conv).toMatchObject({ scenarioId: 'tea', completed: true, goalStepsDone: ['order'] });
    expect((await target.turns.toArray()).map((t) => t.zh)).toEqual(['歡迎光臨', '我要茶']);
    // every migrated record is now mergeable: it has a uid
    expect((await target.evidence.toArray()).every((e) => typeof e.uid === 'string')).toBe(true);
    expect(conv!.uid).toEqual(expect.any(String));

    expect(await legacyDbExists()).toBe(false); // deleted only after the copy was verified
    // the other profile got nothing
    expect(await new AnanDB('anan-ron').items.count()).toBe(0);
  });

  it('keeps the old database if the copy fails, so nothing is ever discarded silently', async () => {
    await seedLegacy();
    const { db: target } = openSession('ron');
    await target.open(); // settle any open a session listener started, so close() can't race it
    target.close(); // the copy cannot be written
    await expect(migrateLegacyInto(target)).rejects.toBeTruthy();
    expect(await legacyDbExists()).toBe(true);
    const old = new AnanDB(LEGACY_DB_NAME);
    expect(await old.items.count()).toBe(3);
    old.close();
  });

  it('is a merge: a profile that already has progress keeps it', async () => {
    await seedLegacy();
    const { db: target } = openSession('ron');
    await learnerService.record(
      { item: { kind: 'word', id: 'z' }, skill: 'recognition', kind: 'review_good', at: now },
      now,
    );
    await migrateLegacyInto(target);
    expect((await target.items.toArray()).map((r) => r.item.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'z',
    ]);
    expect(LegacyMigrationError).toBeDefined();
  });

  it('reports no legacy database when there is none', async () => {
    expect(await legacyDbExists()).toBe(false);
  });
});

describe('v5 upgrade', () => {
  it('backfills uid and updatedAt on existing rows', async () => {
    await seedLegacy();
    const upgraded = new AnanDB(LEGACY_DB_NAME);
    const evidence = await upgraded.evidence.toArray();
    expect(new Set(evidence.map((e) => e.uid)).size).toBe(3);
    expect((await upgraded.conversations.toArray())[0]!.updatedAt).toBeInstanceOf(Date);
    expect((await upgraded.settings.get('currentLevel'))?.updatedAt).toBeInstanceOf(Date);
    expect((await upgraded.turns.toArray()).every((t) => t.uid)).toBe(true);
    upgraded.close();
  });
});
