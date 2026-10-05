import { describe, expect, it } from 'vitest';
import {
  checkJournalCloze,
  checkJournalClozeRules,
  type ClozeCheckLLM,
} from '../cloze/check-journal-cloze.js';
import { buildFixtureLexicon } from '../test-fixtures/lexicon-fixture.js';
import { buildErrorCloze, buildErrorItems, checkErrorItem } from './error-bank.js';
import { sentenceAround, splitReviewSentences } from './sentences.js';
import { journalSentencesFromEntry } from './sources.js';
import type { JournalIssue } from './types.js';

const lexicon = buildFixtureLexicon();
const now = new Date('2026-03-01T10:00:00Z');
const issue = (
  text: string,
  wrong: string,
  correction: string,
  over: Partial<JournalIssue> = {},
): JournalIssue => {
  const i = text.indexOf(wrong);
  return {
    span: [i, i + wrong.length],
    type: 'error',
    correction,
    explanationEn: 'because',
    confidence: 'high',
    ...over,
  };
};
const ok: ClozeCheckLLM = { checkCloze: async () => ({ ok: true }) };

// Each describe below is one suspected cause from docs/cloze-reports.md.

describe('cause: several corrections in one sentence', () => {
  const text = '昨天我去了台灣，我喜歡咖啡，我買了一個東西。';
  const issues = [
    { issue: issue(text, '昨天', '今天'), index: 0 },
    { issue: issue(text, '喜歡', '愛'), index: 1 },
    { issue: issue(text, '一個', '兩個'), index: 2 },
  ];
  const items = buildErrorItems('e', text, issues, now, { lexicon });

  it('shows the sentence with ALL corrections applied, never half-fixed', () => {
    expect(items).toHaveLength(3);
    for (const it of items) expect(it.corrected).toBe('今天我去了台灣，我愛咖啡，我買了兩個東西。');
  });

  it('puts every blank on its own corrected text (no offset drift)', () => {
    expect(items.map((i) => buildErrorCloze(i).answer)).toEqual(['今天', '愛', '兩個']);
    for (const it of items) {
      const c = buildErrorCloze(it);
      expect(c.sentence.slice(0, c.blankStart) + c.answer + c.sentence.slice(c.blankEnd)).toBe(
        it.corrected,
      );
    }
  });

  it('gives the same result whatever order the issues arrive in', () => {
    const rev = buildErrorItems('e', text, [...issues].reverse(), now, { lexicon });
    expect(rev.map((i) => i.corrected)).toEqual(items.map((i) => i.corrected));
  });
});

describe('cause: a span that splits a word', () => {
  // the model blamed 很喜, which ends in the middle of the word 喜歡
  const text = '我很喜歡咖啡。';
  it('widens the blank to the whole word', () => {
    const [it] = buildErrorItems(
      'e',
      text,
      [{ issue: issue(text, '很喜', '不喜'), index: 0 }],
      now,
      { lexicon },
    );
    const c = buildErrorCloze(it!);
    expect(c.sentence).toBe('我不喜歡咖啡。');
    expect(c.answer).toBe('不喜歡');
    // the blank never starts or ends inside a token
    expect(checkJournalClozeRules({ ...c, sentence: c.sentence }, { lexicon })).toEqual([]);
  });
});

describe('cause: a span that crosses a sentence boundary', () => {
  it('pulls in every sentence it touches, and the check refuses the multi-sentence result', async () => {
    const text = '我去了。台灣很好。';
    const [it] = buildErrorItems(
      'e',
      text,
      [{ issue: issue(text, '了。台', '了！台'), index: 0 }],
      now,
      { lexicon },
    );
    expect(it!.original).toBe('我去了。台灣很好。');
    expect(it!.status).toBe('blocked');
    expect(it!.blockedReason).toMatch(/single sentence/);
  });
});

describe('cause: sentence splitting inside quotes', () => {
  const text = '他說：「我去。你呢？」我說好。';
  it('keeps a quotation in one sentence', () => {
    const spans = splitReviewSentences(text).map(([a, b]) => text.slice(a, b));
    expect(spans).toEqual(['他說：「我去。你呢？」', '我說好。']);
  });
  it('sentenceAround never cuts a quote in half', () => {
    const [s, e] = sentenceAround(text, [5, 6]);
    expect(text.slice(s, e)).toBe('他說：「我去。你呢？」');
  });
});

describe('cause: the learner\'s uncorrected text used as a cloze source', () => {
  it('only offers sentences that raised no issue', () => {
    const text = '我去了台灣。我很喜歡咖啡。';
    const out = journalSentencesFromEntry(text, [[7, 9]], now);
    expect(out.map((o) => o.zh)).toEqual(['我去了台灣。']);
  });
  it('offers nothing when the entry has no review yet', () => {
    expect(journalSentencesFromEntry('我去了台灣。', null, now)).toEqual([]);
  });
});

describe('cause: brackets', () => {
  it('blocks a sentence that still holds a [gap] or its translation markers', () => {
    const text = '我去 [gym] 運動。';
    const [it] = buildErrorItems('e', text, [{ issue: issue(text, '我', '你'), index: 0 }], now, {
      lexicon,
    });
    expect(it!.status).toBe('blocked');
    expect(it!.blockedReason).toMatch(/bracket/);
  });
});

describe('cause: emoji / rare characters (UTF-16 vs character offsets)', () => {
  it('blocks items whose offsets cannot be trusted after an emoji', () => {
    const text = '今天好😀。我昨天去了台灣。';
    const [it] = buildErrorItems(
      'e',
      text,
      [{ issue: issue(text, '昨天', '今天'), index: 0 }],
      now,
      { lexicon },
    );
    expect(it!.status).toBe('blocked');
    expect(it!.blockedReason).toMatch(/unreliable|emoji/);
  });
  it('blocks any sentence that itself contains an emoji or a non-BMP character', () => {
    for (const sentence of ['我愛咖啡😀。', '我愛𠮷野家。']) {
      const reasons = checkJournalClozeRules(
        { sentence, blankStart: 1, blankEnd: 2, answer: sentence.slice(1, 2) },
        { lexicon },
      );
      expect(reasons.join()).toMatch(/emoji|rare/);
    }
  });
});

describe('checkJournalClozeRules', () => {
  const good = { sentence: '我昨天去了台灣。', blankStart: 1, blankEnd: 3, answer: '昨天' };
  it('passes a clean cloze', () => {
    expect(checkJournalClozeRules(good, { lexicon })).toEqual([]);
  });
  it.each([
    ['simplified characters', { ...good, sentence: '我昨天去了中国。', answer: '昨天' }, /simplified/],
    ['Latin letters', { ...good, sentence: '我昨天去了Taiwan。' }, /Latin/],
    ['markup', { ...good, sentence: '我昨天<b>去了台灣。' }, /markup/],
    ['two sentences', { ...good, sentence: '我昨天去了。台灣。' }, /single sentence/],
    ['empty answer', { ...good, blankEnd: 2, answer: '' }, /out of range|empty/],
    ['whole sentence', { sentence: '我昨天去了台灣。', blankStart: 0, blankEnd: 8, answer: '我昨天去了台灣。' }, /whole sentence/],
    ['answer mismatch', { ...good, answer: '今天' }, /rebuild/],
    ['mid-word blank', { ...good, blankStart: 2, blankEnd: 3, answer: '天' }, /whole words/],
  ])('refuses %s', (_name, input, re) => {
    expect(checkJournalClozeRules(input, { lexicon }).join('; ')).toMatch(re);
  });
  it('allows a Latin name only when listed', () => {
    const input = { sentence: '我跟Rowan去了台灣。', blankStart: 7, blankEnd: 9, answer: '去了' };
    expect(checkJournalClozeRules(input, { lexicon }).join()).toMatch(/Latin/);
    expect(checkJournalClozeRules(input, { lexicon, allowedNames: ['Rowan'] })).toEqual([]);
  });
});

describe('checkJournalCloze (rules + one naturalness check)', () => {
  const input = { sentence: '我昨天去了台灣。', blankStart: 1, blankEnd: 3, answer: '昨天' };
  it('passes, blocks on an objection, and stays pending when the model is unreachable', async () => {
    expect(await checkJournalCloze(input, { lexicon, llm: ok })).toEqual({ status: 'ok' });
    const no: ClozeCheckLLM = { checkCloze: async () => ({ ok: false, reason: 'unnatural' }) };
    expect(await checkJournalCloze(input, { lexicon, llm: no })).toEqual({
      status: 'blocked',
      reason: 'unnatural',
    });
    const down: ClozeCheckLLM = {
      checkCloze: async () => {
        throw new Error('offline');
      },
    };
    expect((await checkJournalCloze(input, { lexicon, llm: down })).status).toBe('pending');
  });
  it('never calls the model for a sentence the rules already refuse', async () => {
    let calls = 0;
    const llm: ClozeCheckLLM = {
      checkCloze: async () => {
        calls++;
        return { ok: true };
      },
    };
    const bad = await checkJournalCloze({ ...input, sentence: '我昨天[去]了台灣。' }, { lexicon, llm });
    expect(bad.status).toBe('blocked');
    expect(calls).toBe(0);
  });
});

describe('checkErrorItem', () => {
  const text = '我昨天去了台灣。';
  const [item] = buildErrorItems('e', text, [{ issue: issue(text, '昨天', '今天'), index: 0 }], now, {
    lexicon,
  });
  it('activates a checked item, blocks a refused one, keeps an unchecked one pending', async () => {
    expect(item!.status).toBe('pending_check');
    expect((await checkErrorItem(item!, { lexicon, llm: ok })).status).toBe('active');
    const no: ClozeCheckLLM = { checkCloze: async () => ({ ok: false, reason: 'odd' }) };
    const blocked = await checkErrorItem(item!, { lexicon, llm: no });
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedReason).toBe('odd');
    expect((await checkErrorItem(item!, { lexicon })).status).toBe('pending_check');
  });
  it('leaves reported items alone', async () => {
    const reported = { ...item!, status: 'reported' as const };
    expect(await checkErrorItem(reported, { lexicon, llm: ok })).toBe(reported);
  });
});
