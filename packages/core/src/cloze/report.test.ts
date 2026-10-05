import { describe, expect, it } from 'vitest';
import { emptyCard } from '../learner/fsrs-instance.js';
import type { ErrorItem } from '../journal/types.js';
import { buildFixtureLexicon } from '../test-fixtures/lexicon-fixture.js';
import {
  blockErrorItem,
  countReports,
  isShowableErrorItem,
  reportedZhSet,
  reportErrorItem,
  restoreErrorItem,
  type SourceReport,
} from './report.js';
import { selectClozeSource } from './source.js';

const now = new Date('2026-03-01T10:00:00Z');
const item = (over: Partial<ErrorItem> = {}): ErrorItem => ({
  id: 'e:0',
  journalEntryId: 'e',
  original: 'a',
  corrected: 'b',
  span: [0, 1],
  type: 'error',
  card: emptyCard(now),
  flagged: false,
  createdAt: now,
  status: 'active',
  ...over,
});

describe('error item statuses', () => {
  it('only active, unflagged items are showable', () => {
    expect(isShowableErrorItem(item())).toBe(true);
    for (const status of ['pending_check', 'blocked', 'reported', 'deleted', undefined] as const)
      expect(isShowableErrorItem(item({ status }))).toBe(false);
    expect(isShowableErrorItem(item({ flagged: true }))).toBe(false);
  });
  it('report, restore and block keep the card as it was', () => {
    const base = item();
    const reported = reportErrorItem(base, { reason: 'garbled', reportedAt: now, profileId: 'p' });
    expect(reported).toMatchObject({ status: 'reported', report: { reason: 'garbled' } });
    expect(reported.card).toBe(base.card);
    const back = restoreErrorItem(reported);
    expect(back.status).toBe('active');
    expect(back.report).toBeUndefined();
    expect(blockErrorItem(base, 'why')).toMatchObject({ status: 'blocked', blockedReason: 'why' });
  });
});

describe('a reported sentence never comes back, but the word does', () => {
  const lexicon = buildFixtureLexicon();
  const word = lexicon.lookup('咖啡')[0]!;
  const opts = {
    lexicon,
    knownIds: new Set(lexicon.lookup('我').concat(lexicon.lookup('喜歡'), lexicon.lookup('很')).map((w) => w.id)),
    learnerLevel: 'L2' as const,
    bankSentences: [
      { id: 'a', zh: '我喜歡咖啡。', en: 'I like coffee.', targetWordId: word.id, level: 'L1' as const, tokens: [], source: 'generated' as const, doubtful: false },
      { id: 'b', zh: '我很喜歡咖啡。', en: 'I really like coffee.', targetWordId: word.id, level: 'L1' as const, tokens: [], source: 'generated' as const, doubtful: false },
    ],
  };
  it('picks another sentence once the first is excluded', () => {
    const first = selectClozeSource(word, opts)!;
    const reports: SourceReport[] = [
      { zh: first.zh, sourceKind: 'bank', sourceLabel: '', reason: 'garbled', reportedAt: now, profileId: 'p', state: 'reported' },
      { zh: 'restored one', sourceKind: 'bank', sourceLabel: '', reason: 'garbled', reportedAt: now, profileId: 'p', state: 'restored' },
    ];
    const excluded = reportedZhSet(reports);
    expect(excluded.has('restored one')).toBe(false);
    const second = selectClozeSource(word, { ...opts, excludeZh: excluded })!;
    expect(second.zh).not.toBe(first.zh);
    const none = selectClozeSource(word, {
      ...opts,
      excludeZh: new Set(opts.bankSentences.map((s) => s.zh)),
    });
    expect(none).toBeNull(); // the word falls back to a plain card, it isn't dropped
  });
});

describe('countReports', () => {
  it('counts by source and reason', () => {
    expect(
      countReports([
        { sourceKind: 'bank', reason: 'garbled' },
        { sourceKind: 'bank', reason: 'garbled' },
        { sourceKind: 'chat', reason: 'other' },
      ]),
    ).toEqual({ 'bank:garbled': 2, 'chat:other': 1 });
  });
});
