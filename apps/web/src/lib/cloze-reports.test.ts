import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyCard,
  selectDueErrorItems,
  type ErrorItem,
  type Evidence,
} from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import {
  deleteJournalItem,
  excludedZh,
  loadSourceReports,
  reportCounts,
  reportJournalItem,
  reportSource,
  restoreJournalItem,
  restoreSource,
} from './cloze-reports.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let service: LearnerService;
let repo: DexieLearnerRepo;
const now = new Date('2026-03-01T10:00:00Z');
const who = (reason: 'garbled' | 'other' = 'garbled') => ({ reason, profileId: 'rowan', note: 'n' });

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  repo = new DexieLearnerRepo(db);
  service = new LearnerService(repo);
});
afterEach(async () => {
  await db.delete();
});

const ev = (kind: Evidence['kind'], at: Date): Evidence => ({
  item: { kind: 'word', id: 'w-1' },
  skill: 'recognition',
  kind,
  at,
});

describe('evidence undo (reporting after answering)', () => {
  it('restores the card exactly and removes the evidence event', async () => {
    await service.record(ev('review_good', new Date('2026-02-27T10:00:00Z')), new Date('2026-02-27T10:00:00Z'));
    const before = await repo.getCard({ kind: 'word', id: 'w-1' }, 'recognition');
    const evidenceBefore = await db.evidence.count();
    expect(before).toBeDefined();

    const handle = await service.recordUndoable(ev('cloze_wrong', now), now);
    const after = await repo.getCard({ kind: 'word', id: 'w-1' }, 'recognition');
    expect(after).not.toEqual(before); // the wrong answer really did change it (a lapse)
    expect(await db.evidence.count()).toBe(evidenceBefore + 1);

    await handle.undo();
    expect(await repo.getCard({ kind: 'word', id: 'w-1' }, 'recognition')).toEqual(before);
    expect(await db.evidence.count()).toBe(evidenceBefore);
  });

  it('removes a card that did not exist before the answer', async () => {
    const handle = await service.recordUndoable(ev('cloze_wrong', now), now);
    expect(await repo.getCard({ kind: 'word', id: 'w-1' }, 'recognition')).toBeDefined();
    await handle.undo();
    expect(await repo.getCard({ kind: 'word', id: 'w-1' }, 'recognition')).toBeUndefined();
    expect(await db.evidence.count()).toBe(0);
  });
});

function errorItem(over: Partial<ErrorItem> = {}): ErrorItem {
  return {
    id: 'e1:0',
    journalEntryId: 'e1',
    original: '我昨天去了台灣。',
    corrected: '我今天去了台灣。',
    span: [1, 3],
    blank: [1, 3],
    type: 'error',
    card: emptyCard(new Date('2026-01-01')),
    flagged: false,
    createdAt: now,
    status: 'active',
    version: 2,
    ...over,
  };
}

describe('reporting a journal item', () => {
  it('takes it out of review (restoring its pre-answer card), and Undo/It was fine bring it back', async () => {
    const item = errorItem();
    await db.errorItems.put(item);
    expect(selectDueErrorItems(await db.errorItems.toArray(), now, 10)).toHaveLength(1);

    await reportJournalItem(db, item, who(), now);
    const stored = (await db.errorItems.get(item.id))!;
    expect(stored.status).toBe('reported');
    expect(stored.report).toMatchObject({ reason: 'garbled', profileId: 'rowan', note: 'n' });
    expect(stored.card).toEqual(item.card);
    expect(selectDueErrorItems(await db.errorItems.toArray(), now, 10)).toEqual([]);

    await restoreJournalItem(db, stored);
    const back = (await db.errorItems.get(item.id))!;
    expect(back.status).toBe('active');
    expect(back.report).toBeUndefined();
    expect(selectDueErrorItems(await db.errorItems.toArray(), now, 10)).toHaveLength(1);
  });

  it('delete removes it from the bank for good', async () => {
    const item = errorItem();
    await db.errorItems.put(item);
    await deleteJournalItem(db, item);
    expect((await db.errorItems.get(item.id))!.status).toBe('deleted');
    expect(selectDueErrorItems(await db.errorItems.toArray(), now, 10)).toEqual([]);
  });
});

describe('reporting any other source', () => {
  const src = { zh: '我喜歡咖啡。', sourceKind: 'bank' as const, sourceLabel: 'example sentence' };
  it('excludes the sentence until it is restored, and counts it by source and reason', async () => {
    await reportSource(db, src, who(), now);
    expect((await excludedZh(db)).has(src.zh)).toBe(true);
    expect((await loadSourceReports(db))[0]).toMatchObject({ zh: src.zh, reason: 'garbled', state: 'reported' });
    expect(await reportCounts(db)).toEqual({ 'bank:garbled': 1 });
    await restoreSource(db, src.zh);
    expect((await excludedZh(db)).has(src.zh)).toBe(false);
  });
});
