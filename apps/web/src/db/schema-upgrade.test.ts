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

describe('schema upgrades (v6 phase 9, v8 phase 17)', () => {
  it('upgrades a v5 database: nothing is lost and the reader tables exist', async () => {
    name = `anan-upgrade-${Math.random()}`;
    await seedV5(name);

    const db = new AnanDB(name);
    await db.open();
    expect(db.verno).toBe(10);
    // Phase 24 (v10): the story library exists and starts empty
    expect(await db.stories.count()).toBe(0);
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

describe('schema v8 (phase 17)', () => {
  it('puts every existing journal item on hold until it has been rebuilt, but keeps reported ones', async () => {
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
    await old.table('errorItems').bulkPut([
      { id: 'e1:0', journalEntryId: 'e1', flagged: false },
      { id: 'e1:1', journalEntryId: 'e1', flagged: false, status: 'reported' },
      { id: 'e1:2', journalEntryId: 'e1', flagged: false, version: 2, status: 'active' },
    ]);
    old.close();

    const db = new AnanDB(name);
    await db.open();
    expect((await db.errorItems.get('e1:0'))?.status).toBe('pending_rebuild');
    expect((await db.errorItems.get('e1:1'))?.status).toBe('reported');
    expect((await db.errorItems.get('e1:2'))?.status).toBe('active');
    db.close();
  });
});

describe('schema v9 (phase 20)', () => {
  it('backfills each card’s source from its first evidence and re-spreads unreviewed bulk cards', async () => {
    name = `anan-upgrade-${Math.random()}`;
    await seedV5(name);
    const old = new Dexie(name);
    await old.open(); // dynamic mode: the v5 tables as they are
    const due = new Date('2026-10-10T00:00:00Z');
    const card = (id: string, imported: boolean) => ({
      pk: `word:${id}:recognition`,
      item: { kind: 'word', id },
      skill: 'recognition',
      card: { due, stability: 3, difficulty: 5, elapsed_days: 0, scheduled_days: 3, learning_steps: 0, reps: 1, lapses: 0, state: 2, last_review: due },
      state: 'review',
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      familiarity: 0,
      readingDependence: 0,
      flags: imported ? { imported: true } : {},
      updatedAt: due,
    });
    await old.table('items').bulkPut([...Array.from({ length: 200 }, (_, i) => card(`imp-${i}`, true)), card('w1', false)]);
    old.close();

    const db = new AnanDB(name);
    await db.open();
    expect(db.verno).toBe(10);
    const rows = await db.items.toArray();
    expect(rows.find((r) => r.item.id === 'w1')!.source).toBe('study_order');
    const imported = rows.filter((r) => r.item.id.startsWith('imp-'));
    expect(imported.every((r) => r.source === 'anki')).toBe(true);
    const perDay = new Map<string, number>();
    for (const r of imported) {
      const d = new Date(r.card.due).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(40);
    db.close();
  });
});
