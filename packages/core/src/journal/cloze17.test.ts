import { describe, expect, it } from 'vitest';
import { journalLexicon, scriptedJournalLLM } from '../test-fixtures/journal-llm.js';
import { buildSentenceItems, planSentenceItems, BLANK } from './buildItems.js';
import { resolveEdits } from './edits.js';
import { carryOverSchedule, legacyAnswer } from './rebuild.js';
import {
  gradeErrorItem,
  mistakeGone,
  patchExerciseSentence,
  reconsiderAnswer,
} from './grade-item.js';
import { reviewErrorItem } from './error-bank.js';
import {
  attachModelReviews,
  buildEntryItems,
  clozeSourceSentences,
  prepareSentences,
  suggestProtectedTerms,
  verifyEntrySentences,
} from './pipeline.js';
import { sentenceKey, verifyCorrected, type SentenceCache, type VerifiedSentence } from './verifyCorrected.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import { segment } from '../segment.js';
import type { ErrorItem, ModelSentenceReview } from './types.js';

const lexicon = journalLexicon();
const now = new Date('2026-03-01T10:00:00Z');
const PROTECTED = ['印', '羅恩'];
const baseDeps = (llm = scriptedJournalLLM()) => ({
  lexicon,
  llm,
  protectedTerms: PROTECTED,
  learnerLevel: 'L1' as const,
  now,
});

const review = (over: Partial<ModelSentenceReview> & Pick<ModelSentenceReview, 'corrected'>): ModelSentenceReview => ({
  index: 0,
  en: 'My surname is Yin and my name is Rowan.',
  edits: [],
  ...over,
});

async function verified(original: string, rev: ModelSentenceReview, llm = scriptedJournalLLM()) {
  return verifyCorrected(baseDeps(llm), { original, start: 0, end: original.length, review: rev, now });
}

describe("the owner's example: 我的姓印名字印羅恩。", () => {
  const original = '我的姓印名字印羅恩。';
  const corrected = '我的姓是印，名字是羅恩。';

  it('gets a fully correct sentence and items that never blank 印 or 羅恩', async () => {
    const llm = scriptedJournalLLM({
      solve: (req) =>
        req.sentence.includes(`姓${BLANK}印`)
          ? { answers: ['是'], confident: true }
          : { answers: ['是', '叫'], confident: true },
    });
    const vs = await verified(original, review({ corrected }), llm);
    expect(vs.status).toBe('verified');
    expect(vs.corrected).toBe(corrected);

    const { items } = await buildSentenceItems({ ...baseDeps(llm) }, 'e1', 0, vs);
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) {
      expect(it.corrected).toBe(corrected); // nothing wrong is ever visible around a blank
      const ex = it.exercise!;
      if (ex.blankStart !== undefined) {
        const blanked = it.corrected.slice(ex.blankStart, ex.blankEnd);
        expect(blanked).toBe(ex.answer);
        expect(blanked).not.toMatch(/印|羅|恩/);
        expect(blanked.length).toBeLessThanOrEqual(2);
      }
    }
    const missing = items.find((i) => i.exercise!.prompt === 'A word is missing here.')!;
    expect(missing.exercise).toMatchObject({ kind: 'cloze', answer: '是' });
    expect(missing.corrected.slice(missing.exercise!.blankStart, missing.exercise!.blankEnd)).toBe('是');
    expect(missing.exercise!.accepted).toContain('是');
    expect(missing.id).toMatch(/^v2:e1:0:/);
  });

  it('accepts 是 for the 印->叫 fix: the learner who types it is not marked wrong', async () => {
    const llm = scriptedJournalLLM({
      solve: () => ({ answers: ['叫', '是'], confident: true }),
    });
    const vs = await verified(original, review({ corrected: '我姓印，名字叫羅恩。' }), llm);
    const { items } = await buildSentenceItems(baseDeps(llm), 'e1', 0, vs);
    const swap = items.find((i) => i.exercise!.answer === '叫')!;
    expect(swap).toBeDefined();
    expect(swap.exercise!.accepted).toEqual(expect.arrayContaining(['叫', '是']));
    expect(gradeErrorItem(swap, { kind: 'text', text: '是' }, lexicon)).toBe('correct');
    expect(gradeErrorItem(swap, { kind: 'text', text: '印' }, lexicon)).toBe('wrong');
    // the 的 that should go is a "tap the word that doesn't belong" item on the learner's sentence
    const extra = items.find((i) => i.exercise!.kind === 'extra_word')!;
    expect(extra.exercise!.tokens![extra.exercise!.extraTokenIndex!]).toBe('的');
    expect(gradeErrorItem(extra, { kind: 'tap', tokenIndex: extra.exercise!.extraTokenIndex! }, lexicon)).toBe('correct');
  });
});

describe('Part B: nothing that failed the check is ever shown', () => {
  const original = '我的姓印名字印羅恩。';
  const rev = review({ corrected: '我的姓是印，名字是羅恩。' });

  it('a failing checker rejects the sentence after exactly one retry, and no item is built', async () => {
    const llm = scriptedJournalLLM({
      verify: () => ({ ok: false, problem: 'unnatural', meaningMatches: true }),
      fix: () => review({ corrected: '我姓印，名字叫羅恩。' }),
    });
    const vs = await verified(original, rev, llm);
    expect(vs.status).toBe('rejected');
    expect(llm.calls.fix).toBe(1);
    expect(llm.calls.verify).toHaveLength(2);
    const built = await buildSentenceItems(baseDeps(llm), 'e1', 0, vs);
    expect(built.items).toEqual([]);
  });

  it('the retry can rescue the sentence', async () => {
    let first = true;
    const llm = scriptedJournalLLM({
      verify: () => {
        const ok = !first;
        first = false;
        return { ok, problem: ok ? '' : 'unnatural', meaningMatches: true };
      },
      fix: () => review({ corrected: '我姓印，名字叫羅恩。' }),
    });
    const vs = await verified(original, rev, llm);
    expect(vs.status).toBe('verified');
    expect(vs.corrected).toBe('我姓印，名字叫羅恩。');
  });

  it('the checker is told to avoid the provider that wrote the correction, and never sees the original', async () => {
    const llm = scriptedJournalLLM();
    await verifyCorrected(baseDeps(llm), {
      original,
      start: 0,
      end: original.length,
      review: rev,
      servedBy: 'gemini',
      now,
    });
    expect(llm.calls.verify[0]).toMatchObject({ zh: rev.corrected, avoidProvider: 'gemini' });
    expect(JSON.stringify(llm.calls.verify)).not.toContain(original);
  });

  it('rules reject simplified characters, brackets, Latin and changed protected terms without a model call', async () => {
    for (const corrected of ['我的姓是印，名字是罗恩。', '我姓印 [Yin]。', '我姓 Yin。', '我姓是羅，名字是恩。']) {
      const llm = scriptedJournalLLM({ fix: () => review({ corrected }) });
      const vs = await verified(original, review({ corrected }), llm);
      expect(vs.status, corrected).toBe('rejected');
    }
  });

  it('a meaning mismatch is an objection too', async () => {
    const llm = scriptedJournalLLM({
      verify: () => ({ ok: true, problem: '', meaningMatches: false }),
      fix: () => rev,
    });
    expect((await verified(original, rev, llm)).status).toBe('rejected');
  });
});

describe('Part A: model offsets are never used', () => {
  it('edits that do not reproduce `corrected` are discarded for the diff', async () => {
    const bad = review({
      corrected: '我的姓是印，名字是羅恩。',
      edits: [{ before: '印', after: '是印', contextBefore: '我的姓', kind: 'wrong_word', explanationEn: 'x' }],
    });
    const vs = await verified('我的姓印名字印羅恩。', bad);
    expect(vs.status).toBe('verified');
    expect(vs.modelEditsUsable).toBe(false);
    expect(vs.edits.some((e) => e.after === '是印')).toBe(false);
  });
  it('the model cannot change `original`: code attaches it', () => {
    const text = '我去台灣。你呢？';
    const prepared = prepareSentences(text);
    const raws = attachModelReviews(prepared, [
      { index: 1, corrected: '你呢？', en: 'And you?', edits: [] },
      { index: 9, corrected: 'zzz', en: '', edits: [] },
    ]);
    expect(raws.map((r) => r.original)).toEqual(['我去台灣。', '你呢？']);
    expect(raws[0]!.review).toBeUndefined();
    expect(raws[1]!.review?.corrected).toBe('你呢？');
  });
  it('sentences with gaps, no Chinese or too long are never reviewed', () => {
    expect(prepareSentences('我去 [gym]。OK。我去台灣。').map((p) => p.original)).toEqual(['我去台灣。']);
  });
});

describe('Part C: blanks follow the hard rules', () => {
  const vs = (original: string, corrected: string) => ({
    original,
    corrected,
    edits: resolveEdits(original, corrected, [], lexicon)!.edits,
  });
  it('never blanks a protected name or a number', () => {
    const named = vs('我是羅思。', '我是羅恩。');
    const planNamed = planSentenceItems(named, { lexicon, protectedTerms: ['羅恩'] });
    expect(planNamed.plans).toEqual([]);
    expect(planNamed.unbuildable.length).toBeGreaterThan(0);

    const numbers = vs('我有二個朋友。', '我有三個朋友。');
    const planNum = planSentenceItems(numbers, { lexicon, protectedTerms: [] });
    expect(planNum.plans.filter((p) => p.kind === 'cloze' || p.kind === 'choice')).toEqual([]);
  });
  it('a punctuation-only change makes no item', () => {
    expect(planSentenceItems(vs('我喜歡咖啡。', '我喜歡咖啡！'), { lexicon, protectedTerms: [] }).plans).toEqual([]);
  });
  it('a larger rewrite becomes one "Fix my sentence" item, never a cloze', () => {
    const plan = planSentenceItems(vs('我喜歡咖啡。', '我喜歡很重要的咖啡。'), { lexicon, protectedTerms: [] });
    expect(plan.plans.map((p) => p.kind)).toEqual(['fix']);
  });
  it('word order becomes a reorder of the corrected sentence', () => {
    const plan = planSentenceItems(vs('我去昨天台灣。', '我昨天去台灣。'), { lexicon, protectedTerms: [] });
    expect(plan.plans[0]).toMatchObject({ kind: 'reorder' });
    expect(plan.plans[0]!.tokens!.join('')).toBe('我昨天去台灣。');
  });
  it('mainland wording becomes a choice between the learner\'s word and the Taiwan word', async () => {
    const llm = scriptedJournalLLM({
      verify: (req) => ({ ok: !req.zh.includes('地鐵'), problem: 'mainland', meaningMatches: true }),
    });
    const sentence = await verifyCorrectedFor('我去地鐵。', '我去捷運。', llm);
    const { items } = await buildSentenceItems(baseDeps(llm), 'e', 0, sentence);
    expect(items[0]!.exercise).toMatchObject({ kind: 'choice', options: ['地鐵', '捷運'], prompt: 'Pick the Taiwan word.' });
  });
  it('an undecidable blank is dropped (insertion) rather than shown', async () => {
    const llm = scriptedJournalLLM({ solve: () => ({ answers: [], confident: false }) });
    const sentence = await verifyCorrectedFor('我喜歡咖啡。', '我很喜歡咖啡。', llm);
    const out = await buildSentenceItems(baseDeps(llm), 'e', 0, sentence);
    expect(out.items).toEqual([]);
    expect(out.dropped[0]!.reason).toMatch(/decided/);
  });
  it('a solver answer that fails the whole-sentence check is not accepted', async () => {
    const llm = scriptedJournalLLM({
      verify: (req) => ({ ok: !req.zh.includes('不'), problem: 'no', meaningMatches: true }),
      solve: () => ({ answers: ['很', '不'], confident: true }),
    });
    const sentence = await verifyCorrectedFor('我喜歡咖啡。', '我很喜歡咖啡。', llm);
    const { items } = await buildSentenceItems(baseDeps(llm), 'e', 0, sentence);
    expect(items[0]!.exercise!.accepted).toEqual(['很']);
  });
});

async function verifyCorrectedFor(original: string, corrected: string, llm = scriptedJournalLLM()) {
  return verified(original, review({ corrected, en: 'English.' }), llm);
}

describe('Part D: grading and "I think mine is right too"', () => {
  async function swapItem(): Promise<ErrorItem> {
    const llm = scriptedJournalLLM({ solve: () => ({ answers: ['昨天'], confident: true }) });
    const sentence = await verifyCorrectedFor('我今天去了台灣。', '我昨天去了台灣。', llm);
    const { items } = await buildSentenceItems(baseDeps(llm), 'e', 0, sentence);
    return items[0]!;
  }

  it('regrades a rejected-but-fine answer and the schedule comes out as if it had been right', async () => {
    const prior = await swapItem();
    expect(gradeErrorItem(prior, { kind: 'text', text: '前天' }, lexicon)).toBe('wrong');
    const wrongly = reviewErrorItem(prior, 'wrong', now);

    const llm = scriptedJournalLLM(); // checker likes 我前天去了台灣。
    const res = await reconsiderAnswer(
      { lexicon, llm, protectedTerms: [] },
      prior,
      { kind: 'text', text: '前天' },
    );
    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.item.exercise!.accepted).toContain('前天');
    expect(llm.calls.verify[0]!.zh).toBe('我前天去了台灣。');
    // the wrong grade is undone: re-reviewing from the card as it was before gives a plain "correct"
    const regraded = reviewErrorItem(res.item, 'correct', now);
    expect(regraded.card).toEqual(reviewErrorItem(prior, 'correct', now).card);
    expect(regraded.card).not.toEqual(wrongly.card);
    expect(gradeErrorItem(res.item, { kind: 'text', text: '前天' }, lexicon)).toBe('correct');
  });

  it('keeps the grade when the checker objects', async () => {
    const prior = await swapItem();
    const llm = scriptedJournalLLM({ verify: () => ({ ok: false, problem: 'odd', meaningMatches: true }) });
    const res = await reconsiderAnswer({ lexicon, llm, protectedTerms: [] }, prior, { kind: 'text', text: '前天' });
    expect(res).toEqual({ accepted: false, reason: 'odd' });
  });

  it('"Fix my sentence" answers: exact match, otherwise a full-sentence check plus the mistake being gone', async () => {
    const llm = scriptedJournalLLM();
    const sentence = await verifyCorrectedFor('我喜歡咖啡。', '我喜歡很重要的咖啡。', llm);
    const { items } = await buildSentenceItems(baseDeps(llm), 'e', 0, sentence);
    const fix = items[0]!;
    expect(fix.exercise!.kind).toBe('fix');
    expect(gradeErrorItem(fix, { kind: 'text', text: '我喜歡很重要的咖啡' }, lexicon)).toBe('correct');
    expect(gradeErrorItem(fix, { kind: 'text', text: '我很喜歡很重要的咖啡。' }, lexicon)).toBe('needs_check');
    const fine = await reconsiderAnswer({ lexicon, llm, protectedTerms: [] }, fix, {
      kind: 'text',
      text: '我很喜歡很重要的咖啡。',
    });
    expect(fine.accepted).toBe(true);
    // an insertion's mistake can't be "still there"; the full-sentence check decides
    expect(mistakeGone(fix, '我喜歡咖啡。')).toBe(true);
    const picky = scriptedJournalLLM({ verify: () => ({ ok: false, problem: 'odd', meaningMatches: true }) });
    const rejected = await reconsiderAnswer({ lexicon, llm: picky, protectedTerms: [] }, fix, {
      kind: 'text',
      text: '我喜歡咖啡。',
    });
    expect(rejected.accepted).toBe(false);
  });

  it('pinyin input gets tone-insensitive partial credit against the accepted words', async () => {
    const item = await swapItem();
    const w = lexicon.lookup('昨天')[0]!;
    expect(gradeErrorItem(item, { kind: 'text', text: w.pinyin, mode: 'pinyin' }, lexicon)).toBe('correct');
  });

  it('a hand-edited sentence must still hold the answer exactly once', async () => {
    const item = await swapItem();
    expect(patchExerciseSentence(item, '我昨天去了台灣玩。')!.exercise).toMatchObject({ answer: '昨天' });
    expect(patchExerciseSentence(item, '我去了台灣。')).toBeNull();
  });
});

describe('verifyEntrySentences: cache and failure handling', () => {
  const memory = (): SentenceCache & { store: Map<string, VerifiedSentence> } => {
    const store = new Map<string, VerifiedSentence>();
    return { store, get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) };
  };
  it('checks a sentence once, and keeps an unreachable checker pending instead of failing', async () => {
    const text = '我喜歡咖啡。';
    const raws = attachModelReviews(prepareSentences(text), [
      { index: 0, corrected: text, en: 'I like coffee.', edits: [] },
    ]);
    const cache = memory();
    const llm = scriptedJournalLLM();
    const deps = { ...baseDeps(llm), cache };
    const first = await verifyEntrySentences(deps, raws);
    expect(first.sentences[0]!.status).toBe('verified');
    await verifyEntrySentences(deps, raws);
    expect(llm.calls.verify).toHaveLength(1);
    expect(cache.store.has(sentenceKey(text, PROTECTED))).toBe(true);

    const down = scriptedJournalLLM({
      verify: () => {
        throw new Error('offline');
      },
    });
    const later = await verifyEntrySentences({ ...baseDeps(down), cache: memory() }, raws);
    expect(later.sentences).toEqual([]);
    expect(later.pending).toHaveLength(1);
  });
  it('buildEntryItems: a sentence that was already correct yields no items but is a cloze source', async () => {
    const text = '我喜歡咖啡。';
    const raws = attachModelReviews(prepareSentences(text), [{ index: 0, corrected: text, en: 'I like coffee.', edits: [] }]);
    const { sentences } = await verifyEntrySentences(baseDeps(), raws);
    const built = await buildEntryItems(baseDeps(), 'e', sentences);
    expect(built.items).toEqual([]);
    expect(clozeSourceSentences(sentences).map((s) => s.zh)).toEqual([text]);
  });
  it('a rejected sentence is never a cloze source', () => {
    const rejected = { status: 'rejected', corrected: '我去，台灣。', checkedAt: now } as VerifiedSentence;
    expect(clozeSourceSentences([rejected])).toEqual([]);
  });
});

describe('Part E: carrying the schedule over from the old items', () => {
  const old = (over: Partial<ErrorItem>): ErrorItem => ({
    id: 'e1:0',
    journalEntryId: 'e1',
    original: '我的姓印名字印羅恩。',
    corrected: '我的姓是印名字印羅恩。',
    span: [3, 3],
    blank: [3, 5],
    type: 'error',
    card: { ...emptyCard(now), reps: 4 },
    flagged: false,
    createdAt: new Date('2026-01-01'),
    ...over,
  });
  it('reads what the old item blanked', () => {
    expect(legacyAnswer(old({}))).toBe('是印');
  });
  it('a rebuilt item for the same word inherits the old card; the old item is replaced', async () => {
    const llm = scriptedJournalLLM({ solve: () => ({ answers: ['是'], confident: true }) });
    const sentence = await verifyCorrectedFor('我的姓印名字印羅恩。', '我的姓是印，名字是羅恩。', llm);
    const { items } = await buildSentenceItems(baseDeps(llm), 'e1', 0, sentence);
    const oldItem = old({ itemRef: undefined, corrected: '我的姓是印名字印羅恩。', blank: [3, 4] });
    const out = carryOverSchedule([oldItem], items, () => 'x');
    expect(out.blocked).toEqual([]);
    // every rebuilt item that tests 是 inherits the old card
    expect(out.items.filter((i) => i.card.reps === 4).length).toBeGreaterThanOrEqual(1);
    expect(out.items.every((i) => i.createdAt.getTime() === oldItem.createdAt.getTime())).toBe(true);
  });
  it('an old item with no counterpart is blocked with a reason, not dropped', () => {
    const out = carryOverSchedule([old({})], [], () => 'The sentence could not be rebuilt.');
    expect(out.blocked).toEqual([{ id: 'e1:0', reason: 'The sentence could not be rebuilt.' }]);
  });
});

describe('suggestProtectedTerms', () => {
  it('suggests unknown runs that recur across entries', () => {
    expect(
      suggestProtectedTerms(['我跟羅恩去台灣。', '羅恩喜歡咖啡。', '我喜歡咖啡。'], lexicon),
    ).toContain('羅恩');
  });
});

// keep `segment` import honest: tokens cover the text the diff relies on
it('segment covers whole strings', () => {
  const t = '我的姓印名字印羅恩。';
  expect(segment(t, lexicon).map((x) => x.text).join('')).toBe(t);
});
