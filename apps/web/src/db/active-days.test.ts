import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from '@anan/core';
import { GameService } from '../lib/game-service.js';
import { ledgerFrom } from '../lib/ledger.js';
import { DexieLearnerRepo } from './learner-repo.js';
import { exportBackup } from './backup.js';
import { mergeBackups } from './merge.js';
import { AnanDB, STREAK_BACKFILL_KEY } from './schema.js';

const NY = 'America/New_York';
/** New York wall time on October `d`, 2026 (EDT, UTC−4). */
const oct = (d: number, h = 12, m = 0) => new Date(Date.UTC(2026, 9, d, h + 4, m));
const answer = (at: Date, kind = 'review_good') => ({
  item: { kind: 'word' as const, id: 'w1' },
  skill: 'recognition' as const,
  kind: kind as 'review_good',
  at,
});
const settings = { ...DEFAULT_SESSION_SETTINGS, timeZone: NY };
/** Answers are stored the way the learner service stores them; rewards the way the game pays them. */
const store = (db: AnanDB, ...events: ReturnType<typeof answer>[]) => new DexieLearnerRepo(db).appendEvidence(events);
const pay = (db: AnanDB, ...rewards: { id: string; kind: string; points: number; at: Date; revokes?: string }[]) =>
  new GameService(db).award(rewards as Parameters<GameService['award']>[0]);

const names: string[] = [];
const fresh = () => {
  const n = `anan-active-${Math.random()}`;
  names.push(n);
  return n;
};
afterEach(async () => {
  for (const n of names.splice(0)) await Dexie.delete(n);
});

/** A database as Phase 29 left it (schema v11), with `seed` written into it. */
async function seedV11(dbName: string, seed: (db: Dexie) => Promise<void>): Promise<void> {
  // Opening at v11 with the real class's history, then closing, gives the exact v11 shape.
  const old = new Dexie(dbName);
  old.version(11).stores({
    items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
    evidence: '++id, at, [item.id], kind, uid',
    settings: 'key',
    meta: 'key',
    customWords: 'id, headword',
    conversations: '++id, scenarioId, startedAt, uid',
    turns: '++id, conversationId, at, uid',
    journalEntries: 'id, createdAt, status',
    journalReviews: 'entryId, createdAt',
    errorItems: 'id, journalEntryId, card.due, pattern',
    rewardEvents: 'id, at, kind',
    glossReports: '++id, wordId, at, uid',
    aiGlosses: 'key, at',
    liveSentences: 'id, targetWordId, createdAt',
    readerShown: 'sentenceId, at',
    stories: 'id, createdAt, lessonId, readAt',
  });
  await old.open();
  await old.table('settings').put({ key: 'reviewSettings', value: settings, updatedAt: oct(1) });
  await seed(old);
  old.close();
}

/** The owner's case: answers on 10 days in a row, reward events only on the last 3. */
const ownerHistory = async (db: Dexie) => {
  await db.table('evidence').bulkAdd(Array.from({ length: 10 }, (_, i) => ({ ...answer(oct(i + 1, 9)), uid: `e${i}` })));
  await db.table('evidence').add({ ...answer(oct(11, 9), 'anki_import_seen'), uid: 'import' });
  await db
    .table('rewardEvents')
    .bulkAdd([8, 9, 10].map((d) => ({ id: `r${d}`, kind: 'recall_correct', points: 1, at: oct(d, 9) })));
};

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('Phase 32: active days', () => {
  it('the v12 upgrade back-fills every past active day once, and Home/Progress read a 10-day streak', async () => {
    const name = fresh();
    await seedV11(name, ownerHistory);
    const db = new AnanDB(name);
    await db.open();
    expect(db.verno).toBe(12);
    const days = (await db.activeDays.toArray()).map((r) => r.day);
    expect(days).toEqual(Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`));
    const flag = (await db.settings.get(STREAK_BACKFILL_KEY))?.value;
    expect(flag).toBeTruthy();

    const ledger = await ledgerFrom(db, oct(11, 8), { settings });
    expect(ledger.streak(ledger.activeDays())).toMatchObject({ current: 10, best: 10 });
    expect(ledger.activeToday()).toBe(false);

    // Today's first answer makes it 11.
    await store(db, answer(oct(11, 8, 30)));
    await until(async () => (await db.activeDays.count()) === 11);
    const after = await ledgerFrom(db, oct(11, 9), { settings });
    expect(after.streak(after.activeDays()).current).toBe(11);
    db.close();

    // Running the app again doesn't re-run the back-fill.
    const again = new AnanDB(name);
    await again.open();
    await again.activeDays.delete('2026-10-01');
    await again.ensureActiveDaysBackfill();
    expect(await again.activeDays.get('2026-10-01')).toBeUndefined();
    expect((await again.settings.get(STREAK_BACKFILL_KEY))?.value).toBe(flag);
    again.close();
  });

  it('the first answer of a day adds exactly one row; more answers and passive rows add none', async () => {
    const db = new AnanDB(fresh());
    await db.open();
    await db.settings.put({ key: 'reviewSettings', value: settings });
    await store(db, answer(oct(10, 9), 'chat_read_no_lookup'));
    await store(db, answer(oct(10, 9), 'story_read_no_lookup'));
    await store(db, answer(oct(10, 9), 'placement_known'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.activeDays.count()).toBe(0);

    await store(db, answer(oct(10, 9)));
    await until(async () => (await db.activeDays.count()) === 1);
    await store(db, answer(oct(10, 10)), answer(oct(10, 11), 'cloze_wrong'));
    await pay(db, { id: 'j', kind: 'journal_entry', points: 5, at: oct(10, 12) });
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.activeDays.toArray()).toEqual([{ day: '2026-10-10', at: oct(10, 9) }]);

    // A finished journal entry (its reward) on another day counts; an Undo row doesn't.
    await pay(db, { id: 'undo:x', kind: 'recall_correct', points: -1, at: oct(12, 9), revokes: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.activeDays.count()).toBe(1);
    await pay(db, { id: 'j2', kind: 'journal_entry', points: 5, at: oct(13, 9) });
    await until(async () => (await db.activeDays.count()) === 2);
    db.close();
  });

  it('day boundaries are the profile time zone (around midnight New York time)', async () => {
    const db = new AnanDB(fresh());
    await db.open();
    await db.settings.put({ key: 'reviewSettings', value: settings });
    await store(db, answer(oct(9, 23, 59))); // already Oct 10 in UTC
    await until(async () => (await db.activeDays.count()) === 1);
    await store(db, answer(oct(10, 0, 1)));
    await until(async () => (await db.activeDays.count()) === 2);
    expect((await db.activeDays.toArray()).map((r) => r.day)).toEqual(['2026-10-09', '2026-10-10']);
    db.close();
  });

  it('a fresh browser waits for its history, then back-fills once', async () => {
    const db = new AnanDB(fresh());
    await db.open();
    await db.ensureActiveDaysBackfill();
    expect(await db.settings.get(STREAK_BACKFILL_KEY)).toBeUndefined();
    // the restore lands (hooks off, as a sync merge writes)
    await db.withoutHooks(async () => {
      await db.settings.put({ key: 'reviewSettings', value: settings });
      await db.evidence.bulkAdd([answer(oct(1)), answer(oct(2))]);
    });
    await ledgerFrom(db, oct(3), { settings });
    expect((await db.activeDays.toArray()).map((r) => r.day)).toEqual(['2026-10-01', '2026-10-02']);
    expect(await db.settings.get(STREAK_BACKFILL_KEY)).toBeTruthy();
    db.close();
  });

  it('two devices back-filling the same profile end up with the same rows after sync', async () => {
    const a = fresh();
    const b = fresh();
    await seedV11(a, ownerHistory);
    // device B has the same history but has also answered on Oct 11
    await seedV11(b, async (db) => {
      await ownerHistory(db);
      await db.table('evidence').add({ ...answer(oct(11, 7)), uid: 'b11' });
    });
    const dbA = new AnanDB(a);
    const dbB = new AnanDB(b);
    await Promise.all([dbA.open(), dbB.open()]);
    const [ea, eb] = await Promise.all([exportBackup(dbA), exportBackup(dbB)]);
    const ab = mergeBackups(ea, eb);
    const ba = mergeBackups(eb, ea);
    expect(ab.activeDays).toEqual(ba.activeDays);
    expect(ab.activeDays).toHaveLength(11);
    dbA.close();
    dbB.close();
  });
});
