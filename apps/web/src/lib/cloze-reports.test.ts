import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyCard,
  selectDueErrorItems,
  type ErrorItem,
  type Evidence,
  Lexicon,
  type ClozeCheckLLM,
  type Word,
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
import { runJournalClozeChecks, sentenceCheckKey } from './journal-cloze-check.js';
import { allJournalSentences } from '../db/queries.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let service: LearnerService;
let repo: DexieLearnerRepo;
const now = new Date('2026-03-01T10:00:00Z');
const word = (headword: string): Word => ({
  id: `w-${headword}`,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [...headword],
  tags: [],
});
const lexicon = new Lexicon(['我', '今天', '昨天', '去', '了', '台灣', '喜歡', '咖啡'].map(word));
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

describe('journal clozes are checked before they can be shown', () => {
  const ok: ClozeCheckLLM = { checkCloze: async () => ({ ok: true }) };
  const no: ClozeCheckLLM = { checkCloze: async () => ({ ok: false, reason: 'odd' }) };
  const down: ClozeCheckLLM = {
    checkCloze: async () => {
      throw new Error('offline');
    },
  };

  it('blocks the known-bad old items, activates good ones, and keeps unchecked ones pending', async () => {
    await db.errorItems.bulkPut([
      errorItem({ id: 'good', status: 'pending_check' }),
      // the garbled kind: another mistake left in, a half-word blank, a gap
      errorItem({ id: 'gap', status: undefined, corrected: '我今天去 [gym]。', blank: [1, 3] }),
      errorItem({ id: 'half', status: 'pending_check', blank: [2, 3] }),
    ]);
    const summary = await runJournalClozeChecks(db, lexicon, ok, now);
    expect((await db.errorItems.get('good'))!.status).toBe('active');
    const gap = (await db.errorItems.get('gap'))!;
    expect(gap.status).toBe('blocked');
    expect(gap.blockedReason).toMatch(/bracket/);
    expect((await db.errorItems.get('half'))!.status).toBe('blocked');
    expect(summary.items).toEqual({ active: 1, blocked: 2, pending: 0 });

    // a refusing checker blocks; an unreachable one leaves the item hidden
    await db.errorItems.put(errorItem({ id: 'later', status: 'pending_check' }));
    await runJournalClozeChecks(db, lexicon, down, now);
    expect((await db.errorItems.get('later'))!.status).toBe('pending_check');
    expect(selectDueErrorItems(await db.errorItems.toArray(), now, 10).map((i) => i.id)).toEqual(['good']);
    await runJournalClozeChecks(db, lexicon, no, now);
    expect((await db.errorItems.get('later'))!.status).toBe('blocked');
  });

  it('only offers journal sentences once checked, and never reported ones', async () => {
    await db.journalEntries.put({
      id: 'j1',
      text: '我喜歡咖啡。',
      promptWordIds: [],
      createdAt: now,
      status: 'finished',
      finishedAt: now,
    });
    await db.journalReviews.put({
      entryId: 'j1',
      learnerLevel: 'L1',
      issues: [],
      naturalRewrite: '',
      brackets: [],
      usedWell: [],
      rejectedCount: 0,
      selfFix: {},
      flagged: [],
      explainMore: {},
      levelHeadline: '',
      wordsUsed: [],
      errorsPer100Chars: 0,
      createdAt: now,
    });
    expect(await allJournalSentences(db)).toEqual([]); // not checked yet
    await runJournalClozeChecks(db, lexicon, down, now);
    expect(await allJournalSentences(db)).toEqual([]); // model down: still pending
    await runJournalClozeChecks(db, lexicon, ok, now);
    expect((await allJournalSentences(db)).map((s) => s.zh)).toEqual(['我喜歡咖啡。']);
    expect((await db.settings.get(sentenceCheckKey('我喜歡咖啡。')))?.value).toMatchObject({ ok: true });
    expect(await allJournalSentences(db, new Set(['我喜歡咖啡。']))).toEqual([]);
  });
});
