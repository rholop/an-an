import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { AnanDB } from './schema.js';

let name = '';
afterEach(async () => {
  await Dexie.delete(name);
});

/** A database exactly as the phase 8 release left it (schema v5). */
async function seedV5(dbName: string): Promise<void> {
  const old = new Dexie(dbName);
  old.version(1).stores({
    items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
    evidence: '++id, at, [item.id], kind',
    settings: 'key',
    meta: 'key',
    customWords: 'id, headword',
    conversations: '++id, scenarioId, startedAt',
    turns: '++id, conversationId, at',
  });
  old.version(2).stores({
    journalEntries: 'id, createdAt, status',
    journalReviews: 'entryId, createdAt',
    errorItems: 'id, journalEntryId, card.due, pattern',
  });
  old.version(3).stores({ rewardEvents: 'id, at, kind' });
  old.version(4).stores({ glossReports: '++id, wordId, at', aiGlosses: 'key, at' });
  old.version(5).stores({
    evidence: '++id, at, [item.id], kind, uid',
    conversations: '++id, scenarioId, startedAt, uid',
    turns: '++id, conversationId, at, uid',
    glossReports: '++id, wordId, at, uid',
  });
  await old.open();
  await old.table('settings').put({ key: 'currentLevel', value: 'L2', updatedAt: new Date('2026-01-01') });
  await old.table('evidence').add({
    item: { kind: 'word', id: 'w1' },
    skill: 'recognition',
    kind: 'review_good',
    at: new Date('2026-01-01'),
    uid: 'ev-1',
  });
  old.close();
}

describe('schema upgrades (v6 phase 9, v7 phase 16)', () => {
  it('upgrades a v5 database: nothing is lost and the reader tables exist', async () => {
    name = `anan-upgrade-${Math.random()}`;
    await seedV5(name);

    const db = new AnanDB(name);
    await db.open();
    expect(db.verno).toBe(7);
    expect(await db.settings.get('currentLevel')).toMatchObject({ value: 'L2' });
    expect(await db.evidence.toArray()).toHaveLength(1);
    expect((await db.meta.get('readerEnabledAt'))?.value).toBeInstanceOf(Date);

    await db.liveSentences.put({
      id: 'live-1',
      zh: '我去便利商店',
      en: '',
      targetWordId: 'w1',
      level: 'N1',
      tokens: [],
      source: 'generated-live',
      doubtful: false,
      createdAt: new Date(),
    });
    await db.readerShown.put({ sentenceId: 'live-1', at: new Date() });
    expect(await db.liveSentences.count()).toBe(1);
    // the in-place table is stamped by its hook, like every other mergeable table
    expect((await db.readerShown.get('live-1'))?.updatedAt).toBeInstanceOf(Date);
    db.close();
  });
});

describe('schema v7 (phase 16)', () => {
  it('puts every existing journal item on hold until it has been checked', async () => {
    name = `anan-upgrade-${Math.random()}`;
    await seedV5(name);
    const old = new Dexie(name);
    old.version(5).stores({
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
    });
    await old.open();
    await old.table('errorItems').put({ id: 'e1:0', journalEntryId: 'e1', flagged: false });
    old.close();

    const db = new AnanDB(name);
    await db.open();
    expect((await db.errorItems.get('e1:0'))?.status).toBe('pending_check');
    db.close();
  });
});
