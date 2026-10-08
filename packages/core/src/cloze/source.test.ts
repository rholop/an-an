import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { AnalyzeContext } from '../validate/turn.js';
import type { Word } from '../types.js';
import { analyzeClozeCoverage, selectClozeSource, type ChatLineSource, type SelectClozeSourceOptions } from './source.js';
import type { SentenceBankEntry } from './sentence.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

const KNOWN_WORDS = ['我', '想', '喝', '一杯', '的', '很', '好喝', '昨天', '買', '了', '這', '杯', '要', '謝謝'].map((hw, i) =>
  word({ id: `k${i}`, headword: hw }),
);
const TARGET = word({ id: 'target1', headword: '珍珠奶茶', level: 'N2', variants: ['珍奶'] });
const HARD_WORD = word({ id: 'hard1', headword: '令人陶醉', level: 'L5' });

const lexicon = new Lexicon([...KNOWN_WORDS, TARGET, HARD_WORD]);
const knownIds = new Set(KNOWN_WORDS.map((w) => w.id));

const baseOpts: SelectClozeSourceOptions = { lexicon, knownIds, learnerLevel: 'N2' };

describe('selectClozeSource', () => {
  it('returns null when nothing contains the word', () => {
    expect(selectClozeSource(TARGET, baseOpts)).toBeNull();
  });

  it('prefers a journal sentence over chat and bank', () => {
    const result = selectClozeSource(TARGET, {
      ...baseOpts,
      journalSentences: [{ zh: '我昨天買了一杯珍珠奶茶。', at: new Date('2026-01-01') }],
      chatLines: [{ zh: '我想喝珍珠奶茶。', role: 'learner', scenarioTitle: 'tea-shop', at: new Date('2026-01-02') }],
      bankSentences: [{ id: 's1', zh: '珍珠奶茶很好喝。', en: '', targetWordId: TARGET.id, level: 'N2', tokens: [], source: 'generated', doubtful: false }],
    });
    expect(result?.sourceKind).toBe('journal');
  });

  it('falls back to chat history when there is no journal sentence, picking the most recent match', () => {
    const chatLines: ChatLineSource[] = [
      { zh: '我想喝珍珠奶茶。', role: 'learner', scenarioTitle: 'tea-shop', at: new Date('2026-01-01') },
      { zh: '這杯珍珠奶茶很好喝。', role: 'npc', npcName: '店員', scenarioTitle: 'tea-shop', at: new Date('2026-01-05') },
    ];
    const result = selectClozeSource(TARGET, { ...baseOpts, chatLines });
    expect(result?.sourceKind).toBe('chat');
    expect(result?.zh).toBe('這杯珍珠奶茶很好喝。');
    expect(result?.sourceLabel).toContain('店員');
  });

  it('falls back to the sentence bank when there is no chat match, filtering by targetWordId', () => {
    const bankSentences: SentenceBankEntry[] = [
      { id: 's1', zh: '這是一個句子。', en: '', targetWordId: 'someone-else', level: 'N1', tokens: [], source: 'generated', doubtful: false },
      { id: 's2', zh: '珍珠奶茶很好喝。', en: 'Bubble tea is tasty.', targetWordId: TARGET.id, level: 'N2', tokens: [], source: 'generated', doubtful: false },
    ];
    const result = selectClozeSource(TARGET, { ...baseOpts, bankSentences });
    expect(result?.sourceKind).toBe('bank');
    expect(result?.zh).toBe('珍珠奶茶很好喝。');
  });

  it('a lesson sentence says which lesson it is from (Phase 21)', () => {
    const bankSentences: SentenceBankEntry[] = [
      { id: 'tb-L03-001', zh: '珍珠奶茶很好喝。', en: '', targetWordId: TARGET.id, level: 'N1', tokens: [], source: 'generated', doubtful: false, tags: ['textbook:laixue-1', 'textbook:laixue-1:L03'] },
    ];
    expect(selectClozeSource(TARGET, { ...baseOpts, bankSentences })?.sourceLabel).toBe('來學華語 1 · Lesson 3 sentence');
  });

  it('rejects a chat line that contains the word but is otherwise too hard (coverage gate)', () => {
    const chatLines: ChatLineSource[] = [
      { zh: `這杯珍珠奶茶令人陶醉。`, role: 'npc', npcName: '店員', scenarioTitle: 'tea-shop', at: new Date('2026-01-01') },
    ];
    const bankSentences: SentenceBankEntry[] = [
      { id: 's1', zh: '珍珠奶茶很好喝。', en: '', targetWordId: TARGET.id, level: 'N2', tokens: [], source: 'generated', doubtful: false },
    ];
    // The hard chat line should be skipped (contains an L5 word nothing in
    // knownIds covers) in favor of the easy bank sentence, not returned as-is.
    const result = selectClozeSource(TARGET, { ...baseOpts, chatLines, bankSentences });
    expect(result?.sourceKind).toBe('bank');
  });

  it('matches a word via one of its variant spellings', () => {
    const chatLines: ChatLineSource[] = [
      { zh: '我要珍奶，謝謝。', role: 'learner', scenarioTitle: 'tea-shop', at: new Date('2026-01-01') },
    ];
    const result = selectClozeSource(TARGET, { ...baseOpts, chatLines });
    expect(result?.sourceKind).toBe('chat');
  });

  it('returns null (falls through to "none") when every candidate is too hard', () => {
    const chatLines: ChatLineSource[] = [
      { zh: '這杯珍珠奶茶令人陶醉。', role: 'npc', npcName: '店員', scenarioTitle: 'tea-shop', at: new Date('2026-01-01') },
    ];
    const result = selectClozeSource(TARGET, { ...baseOpts, chatLines });
    expect(result).toBeNull();
  });

  it('excludeZh skips an otherwise-eligible sentence (leech new_context treatment)', () => {
    const bankSentences: SentenceBankEntry[] = [
      { id: 's1', zh: '珍珠奶茶很好喝。', en: '', targetWordId: TARGET.id, level: 'N2', tokens: [], source: 'generated', doubtful: false },
      { id: 's2', zh: '我想喝珍珠奶茶。', en: '', targetWordId: TARGET.id, level: 'N2', tokens: [], source: 'generated', doubtful: false },
    ];
    const result = selectClozeSource(TARGET, {
      ...baseOpts,
      bankSentences,
      excludeZh: new Set(['珍珠奶茶很好喝。']),
    });
    expect(result?.zh).toBe('我想喝珍珠奶茶。');
  });
});

describe('analyzeClozeCoverage', () => {
  const ctx: AnalyzeContext = {
    lexicon,
    learnerLevel: 'N2',
    knownIds,
    dueIds: new Set(),
    targetIds: new Set(),
    learningIds: new Set(),
    allowedExtraIds: new Set(),
  };

  it('a short sentence that is ENTIRELY the target word still passes (nothing left to grade)', () => {
    // The naive Phase-3-style "target" classification would fail this (the
    // target word itself counts against coverage there) — this is the bug
    // analyzeClozeCoverage exists to avoid.
    const result = analyzeClozeCoverage('珍珠奶茶', ctx, TARGET.id);
    expect(result.pass).toBe(true);
    expect(result.coverage).toBe(1);
  });

  it('a short sentence with one known filler word plus the target passes', () => {
    const result = analyzeClozeCoverage('我珍珠奶茶', ctx, TARGET.id);
    expect(result.pass).toBe(true);
  });

  it('fails when the non-target part of the sentence is not known', () => {
    const result = analyzeClozeCoverage('珍珠奶茶令人陶醉', ctx, TARGET.id);
    expect(result.pass).toBe(false);
    expect(result.coverage).toBeLessThan(1);
  });

  it('fails on a simplified character even if coverage would otherwise pass', () => {
    const result = analyzeClozeCoverage('我们珍珠奶茶', ctx, TARGET.id);
    expect(result.pass).toBe(false);
  });
});
