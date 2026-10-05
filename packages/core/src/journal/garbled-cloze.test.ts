import { describe, expect, it } from 'vitest';
import {
  checkJournalCloze,
  checkJournalClozeRules,
  type ClozeCheckLLM,
} from '../cloze/check-journal-cloze.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import { buildFixtureLexicon } from '../test-fixtures/lexicon-fixture.js';
import { journalLexicon, scriptedJournalLLM } from '../test-fixtures/journal-llm.js';
import { buildSentenceItems } from './buildItems.js';
import { checkErrorItem } from './error-bank.js';
import { prepareSentences } from './pipeline.js';
import { sentenceAround, splitReviewSentences } from './sentences.js';
import { journalSentencesFromEntry } from './sources.js';
import type { ErrorItem } from './types.js';
import { verifyCorrected } from './verifyCorrected.js';

const lexicon = buildFixtureLexicon();
const now = new Date('2026-03-01T10:00:00Z');
const ok: ClozeCheckLLM = { checkCloze: async () => ({ ok: true }) };

// Each describe below is one suspected cause from docs/cloze-reports.md. Phase 16
// reproduced them against the old builder; Phase 17 replaced that builder, and
// the same fixtures now run through the new pipeline.
const jl = journalLexicon();
const deps = (llm = scriptedJournalLLM()) => ({
  lexicon: jl,
  llm,
  protectedTerms: [] as string[],
  learnerLevel: 'L1' as const,
  now,
});
async function itemsFor(original: string, corrected: string, llm = scriptedJournalLLM()) {
  const vs = await verifyCorrected(deps(llm), {
    original,
    start: 0,
    end: original.length,
    review: { index: 0, corrected, en: 'English.', edits: [] },
    now,
  });
  return { vs, ...(await buildSentenceItems(deps(llm), 'e', 0, vs)) };
}

describe('cause: several corrections in one sentence', () => {
  const original = '昨天我去了台灣，我喜歡咖啡。';
  const corrected = '今天我去了台灣，我很喜歡咖啡。';
  const solve = (req: { sentence: string }) =>
    req.sentence.startsWith('＿＿＿＿') ? { answers: ['今天'], confident: true } : { answers: ['很'], confident: true };

  it('shows the sentence with ALL corrections applied, never half-fixed', async () => {
    const { items } = await itemsFor(original, corrected, scriptedJournalLLM({ solve }));
    expect(items.length).toBe(2);
    for (const it of items) expect(it.corrected).toBe(corrected);
  });
  it('puts every blank on its own corrected text (no offset drift)', async () => {
    const { items } = await itemsFor(original, corrected, scriptedJournalLLM({ solve }));
    expect(items.map((i) => i.exercise!.answer).sort()).toEqual(['今天', '很']);
    for (const it of items) {
      const ex = it.exercise!;
      expect(it.corrected.slice(ex.blankStart, ex.blankEnd)).toBe(ex.answer);
    }
  });
});

describe('cause: a span that splits a word', () => {
  it('a correction that leaves a half-word is rejected, not shown', async () => {
    const { vs, items } = await itemsFor(
      '我很喜歡咖啡。',
      '我很喜愛咖啡。',
      scriptedJournalLLM({ fix: () => ({ index: 0, corrected: '我很喜愛咖啡。', en: 'x', edits: [] }) }),
    );
    expect(vs.status).toBe('rejected');
    expect(items).toEqual([]);
  });
  it('blanks always cover whole tokens', async () => {
    const { items } = await itemsFor(
      '我昨天去了台灣。',
      '我今天去了台灣。',
      scriptedJournalLLM({ solve: () => ({ answers: ['今天'], confident: true }) }),
    );
    expect(items[0]!.exercise!.answer).toBe('今天');
  });
});

describe('cause: crossing a sentence boundary', () => {
  it('sentences are split by code and reviewed one by one; a two-sentence correction is rejected', async () => {
    expect(prepareSentences('我去了。台灣很好。').map((p) => p.original)).toEqual(['我去了。', '台灣很好。']);
    const { vs } = await itemsFor('我去了台灣', '我去了。台灣很好。', scriptedJournalLLM({ fix: () => ({ index: 0, corrected: '我去了。台灣很好。', en: 'x', edits: [] }) }));
    expect(vs.status).toBe('rejected');
  });
});

describe('cause: sentence splitting inside quotes', () => {
  const text = '他說：「我去。你呢？」我說好。';
  it('keeps a quotation in one sentence', () => {
    expect(splitReviewSentences(text).map(([a, b]) => text.slice(a, b))).toEqual(['他說：「我去。你呢？」', '我說好。']);
    expect(prepareSentences(text)).toHaveLength(2);
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
  it('a sentence holding a [gap] is never reviewed, and a correction that keeps one is rejected', async () => {
    expect(prepareSentences('我去 [gym] 運動。')).toEqual([]);
    const { vs, items } = await itemsFor('我去運動。', '我去 [gym] 運動。', scriptedJournalLLM({ fix: () => ({ index: 0, corrected: '我去 [gym] 運動。', en: 'x', edits: [] }) }));
    expect(vs.status).toBe('rejected');
    expect(items).toEqual([]);
  });
});

describe('cause: emoji / rare characters (UTF-16 vs character offsets)', () => {
  it('a correction containing an emoji or non-BMP character is rejected', async () => {
    for (const corrected of ['我愛咖啡😀。', '我愛𠮷野家。']) {
      const { vs, items } = await itemsFor('我愛咖啡。', corrected, scriptedJournalLLM({ fix: () => ({ index: 0, corrected, en: 'x', edits: [] }) }));
      expect(vs.status, corrected).toBe('rejected');
      expect(items).toEqual([]);
    }
  });
  it('no model offsets are involved, so an emoji earlier in the entry cannot shift an edit', async () => {
    const text = '今天好😀。我昨天去了台灣。';
    const second = prepareSentences(text)[1]!;
    expect(text.slice(second.start, second.end)).toBe('我昨天去了台灣。');
  });
  it('blocks any cloze sentence that itself contains an emoji or a non-BMP character', () => {
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

describe('checkErrorItem (Reported page "Fix it")', () => {
  const item: ErrorItem = {
    id: 'e:0',
    journalEntryId: 'e',
    original: '我昨天去了台灣。',
    corrected: '我今天去了台灣。',
    span: [1, 3],
    blank: [1, 3],
    type: 'error',
    card: emptyCard(now),
    flagged: false,
    createdAt: now,
    status: 'pending_check',
  };
  it('activates a checked item, blocks a refused one, keeps an unchecked one pending', async () => {
    expect((await checkErrorItem(item, { lexicon, llm: ok })).status).toBe('active');
    const no: ClozeCheckLLM = { checkCloze: async () => ({ ok: false, reason: 'odd' }) };
    const blocked = await checkErrorItem(item, { lexicon, llm: no });
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockedReason).toBe('odd');
    expect((await checkErrorItem(item, { lexicon })).status).toBe('pending_check');
  });
  it('leaves reported items alone', async () => {
    const reported = { ...item, status: 'reported' as const };
    expect(await checkErrorItem(reported, { lexicon, llm: ok })).toBe(reported);
  });
});
