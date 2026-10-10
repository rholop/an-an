import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lexicon, type IssueExplanation, type JournalReview, type Word } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { FakeTutorLLM, type FakeJournalScript } from './fake-tutor-llm.js';
import { JournalService, notPractised } from './journal-service.js';
import { LearnerService } from './learner-service.js';

// Phase 31: the owner's report, as a fixture. 我喜歡念書中文。我的老師很[nice］。
let db: AnanDB;
let learnerService: LearnerService;
const now = new Date('2026-10-09T15:00:00Z');

beforeEach(() => {
  db = new AnanDB(`anan-p31-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

const word = (id: string, headword: string, glossEn = headword, level: Word['level'] = 'N1'): Word => ({
  id,
  headword,
  variants: [],
  pos: ['V'],
  level,
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags: [],
});
const lexicon = new Lexicon([
  word('w-i', '我'),
  word('w-like', '喜歡'),
  word('w-study', '念書', 'to study'),
  word('w-nian', '念', 'to read; to study'),
  word('w-chinese', '中文', 'Chinese'),
  word('w-my', '的'),
  word('w-teacher', '老師', 'teacher'),
  word('w-very', '很'),
  word('w-yiren', '宜人', 'nice; pleasant', 'L1'),
  word('w-qinqie', '親切', 'kind; nice', 'L3'),
  word('w-good', '好', 'good'),
  word('w-person', '人', 'person'),
]);

const OWNER = '我喜歡念書中文。我的老師很[nice］。';
const span = (sub: string): [number, number] => [OWNER.indexOf(sub), OWNER.indexOf(sub) + sub.length];
const WHY: IssueExplanation = {
  wrongEn: '念書 already has its object, 書 (book), so it can’t take 中文 after it. This is a verb-object word.',
  fixEn: '念中文 (study Chinese) · 學中文 is the most common way to say it.',
  exampleWrong: '我喜歡念書中文',
  exampleRight: '我喜歡念中文',
};

const ownerReview = (): JournalReview => ({
  issues: [
    {
      span: span('書中文'),
      type: 'error',
      pattern: 'verb-object',
      itemRef: { kind: 'word', id: 'w-study' },
      correction: '中文',
      explanationEn: '念書 already has an object.',
      confidence: 'high',
      explain: WHY,
      meaningEn: 'I like studying Chinese.',
    },
  ],
  natural_rewrite: '我喜歡學中文。我的老師人很好。',
  brackets: [{ en: 'nice', zh: '宜人' }],
  used_well: [],
});

function script(over: FakeJournalScript = {}): FakeJournalScript {
  return {
    review: () => ownerReview(),
    // 中文書 means "Chinese books": a different meaning
    verify: (req) => ({ ok: !req.zh.includes('宜人'), problem: '', meaningMatches: !req.zh.includes('中文書') }),
    gap: () => ({
      options: [
        { zh: '人很好', pinyin: 'rén hěn hǎo', meaningEn: 'a good person', usageEn: 'for people', corrected: '我的老師人很好。' },
        { zh: '親切', pinyin: 'qīnqiè', meaningEn: 'kind', usageEn: 'for people', corrected: '我的老師很親切。' },
        { zh: '宜人', pinyin: 'yírén', meaningEn: 'pleasant', usageEn: '宜人: pleasant, for weather or places, not people', corrected: '我的老師很宜人。' },
      ],
    }),
    ...over,
  };
}
const make = (over: FakeJournalScript = {}) => {
  const llm = new FakeTutorLLM(undefined, script(over));
  let n = 0;
  return { llm, svc: new JournalService(db, lexicon, learnerService, llm, undefined, () => `e${++n}`) };
};

describe('the owner’s entry (Phase 31 acceptance)', () => {
  it('書中文 is an error with a checked "Why?" naming the verb-object rule, and the fix is 中文 (念中文)', async () => {
    const { svc, llm } = make();
    const { review } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    const [issue] = review.issues;
    expect(OWNER.slice(...issue!.span)).toBe('書中文');
    expect(issue).toMatchObject({ type: 'error', correction: '中文', explainStatus: 'checked' });
    expect(issue!.explain!.wrongEn).toMatch(/verb-object|object/);
    expect(issue!.explain!.fixEn).toMatch(/念中文|學中文/);
    expect(llm.journalCalls.explainCheck).toBe(1);
  });

  it('typing 中文 in Spot the mistakes is right without an AI call; the explanation is on the issue to show', async () => {
    const { svc, llm } = make();
    const { entry } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    const r = await svc.recheckSpan(entry.id, 0, '中文');
    expect(r).toMatchObject({ fixed: true });
    expect(llm.journalCalls.check).toBe(0);
  });

  it('an alternative that changes the meaning is shown with its meaning, not as "also good"', async () => {
    const { svc } = make({
      check: () => ({
        acceptable: true,
        noteEn: 'though saying 中文書 is also a good option',
        alternatives: [{ zh: '中文書', meaningEn: 'read Chinese books' }],
      }),
    });
    const { entry } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    const r = await svc.recheckSpan(entry.id, 0, '學中文');
    expect(r.note).toBeUndefined(); // the free-text line is never shown for a right answer
    expect(r.alternatives).toEqual([{ zh: '中文書', meaningEn: 'read Chinese books', sameMeaning: false }]);
  });

  it('[nice］ about a teacher offers 人很好 / 親切 first, never 宜人 first, and adds nothing without a tap', async () => {
    const { svc } = make();
    const { entry, review } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    const gap = review.brackets[0]!;
    expect(gap.en).toBe('nice');
    expect(gap.options!.map((o) => o.zh)).toEqual(['人很好', '親切']);
    expect(gap.options![0]!.corrected).toBe('我的老師人很好。');
    expect(await db.items.count()).toBe(0);
    await svc.addGapWord(entry.id, 'nice', '親切', now);
    expect((await learnerService.getCard({ kind: 'word', id: 'w-qinqie' }, 'production'))?.flags.priority).toBe(true);
    expect(await learnerService.getCard({ kind: 'word', id: 'w-yiren' }, 'production')).toBeUndefined();
  });

  it('Ask about this answers in English with an example; the answer is saved and there on reopen', async () => {
    const { svc, llm } = make({
      ask: (req) => ({
        answerEn: `念書 is 念 + 書 (book): it already has its object, so ${req.question.includes('念書') ? '中文 has nowhere to go' : '?'}. Say 念中文.`,
        examples: [{ zh: '我喜歡念中文。', en: 'I like studying Chinese.' }, { zh: '我用软件', en: 'simplified: dropped' }],
      }),
    });
    const { entry } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    await svc.ask(entry.id, 0, 'Why is 念書中文 wrong if 念書 means study?', ['我', '喜歡', '中文'], now);
    const reopened = await new JournalService(db, lexicon, learnerService, new FakeTutorLLM()).getReview(entry.id);
    const turns = reopened!.asks![0]!;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.a).toMatch(/念書.*object/);
    expect(turns[0]!.examples).toEqual([{ zh: '我喜歡念中文。', en: 'I like studying Chinese.' }]);
    expect(llm.journalCalls.ask).toBe(1);
  });
});

describe('I think mine is right (Part C.3)', () => {
  it('before finishing: the check agrees, the correction is removed and never practised', async () => {
    const { svc } = make({ verify: () => ({ ok: true, problem: '', meaningMatches: true }) });
    const { entry } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    const d = await svc.dispute(entry.id, 0, now);
    expect(d).toMatchObject({ verdict: 'upheld', intendedEn: 'I like studying Chinese.' });
    const review = await svc.getReview(entry.id);
    expect(notPractised(review!).has(0)).toBe(true);
    await svc.reveal(entry.id);
    await svc.finish(entry.id, now);
    expect((await db.evidence.toArray()).some((e) => e.kind === 'journal_misuse')).toBe(false);
  });

  it('after finishing: its error-bank items and evidence are undone', async () => {
    const { svc } = make({
      review: (req) => ({
        ...ownerReview(),
        brackets: [],
        sentences: (req.sentences ?? []).map((zh, index) => ({
          index,
          corrected: zh.replace('書中文', '中文'),
          en: 'x',
          edits: zh.includes('書中文')
            ? [{ before: '書', after: '', contextBefore: '念', kind: 'extra_word' as const, explanationEn: 'x' }]
            : [],
        })),
      }),
      verify: () => ({ ok: true, problem: '', meaningMatches: true }),
      solve: () => ({ answers: [], confident: false }),
    });
    const text = '我喜歡念書中文。';
    const { entry } = await svc.submit({ text, learnerLevel: 'L1' }, now);
    // the explanation was written for this text's spans; point the issue at it
    await db.journalReviews.update(entry.id, {
      issues: [{ ...ownerReview().issues[0]!, span: [4, 7], explainStatus: 'checked' }],
    });
    await svc.reveal(entry.id);
    await svc.finish(entry.id, now);
    expect((await db.evidence.toArray()).filter((e) => e.kind === 'journal_misuse')).toHaveLength(1);
    expect(await learnerService.getCard({ kind: 'word', id: 'w-study' }, 'production')).toBeDefined();
    const itemsBefore = (await db.errorItems.toArray()).filter((i) => i.status !== 'deleted');

    const later = new Date(now.getTime() + 60_000);
    const d = await svc.dispute(entry.id, 0, later);
    expect(d.verdict).toBe('upheld');
    const undone = (await db.evidence.toArray()).filter((e) => e.kind === 'evidence_undone');
    expect(undone).toHaveLength(1);
    // the card didn't exist before the misuse: it goes back to never-shown
    expect((await learnerService.getCard({ kind: 'word', id: 'w-study' }, 'production'))?.state).toBe('unseen');
    const itemsAfter = (await db.errorItems.toArray()).filter((i) => i.status !== 'deleted');
    expect(itemsAfter.length).toBeLessThanOrEqual(itemsBefore.length);
    expect(itemsAfter.some((i) => i.original === text)).toBe(false);
  });

  it('when the check disagrees: "Still a mistake", the correction stays, and the dispute is logged', async () => {
    const { svc } = make({ verify: () => ({ ok: false, problem: '念書 can’t take another object.', meaningMatches: true }) });
    const { entry } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    const d = await svc.dispute(entry.id, 0, now);
    expect(d).toMatchObject({ verdict: 'still_wrong', problem: '念書 can’t take another object.' });
    const review = await svc.getReview(entry.id);
    expect(review!.disputes![0]!.verdict).toBe('still_wrong');
    expect(notPractised(review!).has(0)).toBe(false);
  });
});

describe('explanations that fail, wait or repeat (Part A, E)', () => {
  it('an explanation the check rejects twice is "not sure" and never practised', async () => {
    const { svc } = make({ explainCheck: (req) => ({ results: req.items.map((_, index) => ({ index, ok: false, problem: 'no' })) }) });
    const { entry, review } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    expect(review.issues[0]!.explainStatus).toBe('unsure');
    await svc.reveal(entry.id);
    await svc.finish(entry.id, now);
    expect((await db.evidence.toArray()).some((e) => e.kind === 'journal_misuse')).toBe(false);
  });

  it('an unreachable checker leaves it pending; a retry checks it', async () => {
    let up = false;
    const { svc } = make({
      explainCheck: (req) => {
        if (!up) throw new Error('offline');
        return { results: req.items.map((_, index) => ({ index, ok: true, problem: '' })) };
      },
    });
    const { entry, review } = await svc.submit({ text: OWNER, learnerLevel: 'L1' }, now);
    expect(review.issues[0]!.explainStatus).toBe('pending');
    up = true;
    expect(await svc.retryExplanations(entry.id)).toBe(true);
    expect((await svc.getReview(entry.id))!.issues[0]!.explainStatus).toBe('checked');
  });
});

describe('What did you mean? (Part C.2)', () => {
  it('is sent with the entry, and fixing a "Read as" re-checks aiming at that meaning', async () => {
    const seen: (string | undefined)[] = [];
    const { svc } = make({
      review: (req) => {
        seen.push(req.intendedEn);
        return ownerReview();
      },
    });
    const { entry } = await svc.submit({ text: OWNER, learnerLevel: 'L1', intendedEn: 'I enjoy studying Chinese.' }, now);
    expect(seen).toEqual(['I enjoy studying Chinese.']);
    expect((await svc.getEntry(entry.id))!.intendedEn).toBe('I enjoy studying Chinese.');
    await svc.recheckSpan(entry.id, 0, '中文');
    await svc.setMeaning(entry.id, 'I like reading Chinese books.', 0, now);
    expect(seen[1]).toMatch(/I enjoy studying Chinese\. \| "我喜歡念書中文。" means: I like reading Chinese books\./);
    const review = await svc.getReview(entry.id);
    expect(review!.selfFix).toEqual({});
    expect(review!.meanings).toEqual({ 0: 'I like reading Chinese books.' });
  });
});

describe('old gap words (Part D.4)', () => {
  it('the one-time migration lists bracket words the old rule added; an ambiguous pick like 宜人 is pre-flagged', async () => {
    const { svc } = make();
    await db.journalReviews.put({
      entryId: 'old',
      learnerLevel: 'L1',
      issues: [],
      naturalRewrite: '',
      brackets: [
        { en: 'nice', zh: '宜人', wordId: 'w-yiren', source: 'lexicon' },
        { en: 'teacher', zh: '老師', wordId: 'w-teacher', source: 'lexicon' },
      ],
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
    expect(await svc.migrateLegacyGaps()).toBe(2);
    expect(await svc.migrateLegacyGaps()).toBe(0); // once
    const r = await svc.getReview('old');
    expect(r!.brackets.map((b) => b.legacy)).toEqual(['flagged', 'ask']);
    await svc.settleLegacyGap('old', 'teacher', true, now);
    expect((await svc.getReview('old'))!.brackets[1]!.legacy).toBe('kept');
  });
});
