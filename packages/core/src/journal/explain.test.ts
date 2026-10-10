/* eslint-disable import/no-nodejs-modules, no-restricted-imports --
   a test reads the shared fixture file at packages/core/test/fixtures (outside `src`). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { extractBrackets } from './bracket.js';
import type { EvalFixtureFile } from './eval.js';
import {
  alternativeLine,
  checkAlternativeMeanings,
  checkExplanations,
  contextAround,
  gapCandidates,
  isUsableExplanation,
  resolveGap,
  ruleNoteFor,
  sameMistakeCount,
  sentenceRange,
  type ExplainLLM,
  type GapLLM,
} from './explain.js';
import type { IssueExplanation, JournalIssue } from './types.js';

// The owner's entry (Phase 31): 我喜歡念書中文。我的老師很[nice］。
const OWNER = '我喜歡念書中文。我的老師很[nice］。';
const at = (sub: string): [number, number] => [OWNER.indexOf(sub), OWNER.indexOf(sub) + sub.length];
const VERB_OBJECT: IssueExplanation = {
  wrongEn: '念書 already has its object, 書 (book), so it can’t take 中文 after it.',
  fixEn: '念中文 (study Chinese) · 學中文 is the most common way to say it.',
  exampleWrong: '我喜歡念書中文',
  exampleRight: '我喜歡念中文',
};
const ownerIssue: JournalIssue = {
  span: at('書中文'),
  type: 'error',
  pattern: 'verb-object',
  correction: '中文',
  explanationEn: '念書 already has an object.',
  confidence: 'high',
  explain: VERB_OBJECT,
  meaningEn: 'I like studying Chinese.',
};

function fakeExplainLLM(opts: {
  check?: (item: { correction: string; explain: IssueExplanation }, call: number) => { ok: boolean; problem: string };
  why?: (req: { original: string; correction: string; problem: string }) => IssueExplanation;
  offline?: boolean;
}) {
  const calls = { check: 0, why: 0 };
  const llm: ExplainLLM = {
    async checkJournalExplanations(req) {
      if (opts.offline) throw new Error('offline');
      const call = calls.check++;
      return {
        results: req.items.map((item, index) => ({
          index,
          ...(opts.check?.(item, call) ?? { ok: true, problem: '' }),
        })),
      };
    },
    async explainJournalWhy(req) {
      calls.why++;
      if (opts.offline) throw new Error('offline');
      return (
        opts.why?.(req) ?? {
          wrongEn: `Not ${req.original} here.`,
          fixEn: `Use ${req.correction}.`,
          exampleWrong: req.original || '…',
          exampleRight: req.correction || '…',
        }
      );
    },
  };
  return { llm, calls };
}

describe('the "Why?" of a correction (Part A)', () => {
  it('the owner’s entry: a checked verb-object explanation naming the rule, linked to its rule note', async () => {
    const { llm, calls } = fakeExplainLLM({});
    const [out] = await checkExplanations(llm, [ownerIssue], { text: OWNER, learnerLevel: 'L1' });
    expect(out!.explainStatus).toBe('checked');
    expect(out!.explain!.wrongEn).toMatch(/念書.*object/);
    expect(out!.explain!.fixEn).toMatch(/念中文|學中文/);
    expect(calls).toEqual({ check: 1, why: 0 });
    expect(ruleNoteFor(out!.pattern)?.title).toBe('Verb-object words (離合詞)');
    expect(ruleNoteFor('離合詞')?.examples).toContain('念書 → 念中文');
  });

  it('a failed explanation is written again once and checked again', async () => {
    const { llm, calls } = fakeExplainLLM({
      check: (_item, call) => (call === 0 ? { ok: false, problem: 'It says 中文書 means the same.' } : { ok: true, problem: '' }),
      why: () => VERB_OBJECT,
    });
    const [out] = await checkExplanations(llm, [{ ...ownerIssue, explain: { ...VERB_OBJECT, fixEn: 'Say 中文書.' } }], {
      text: OWNER,
      learnerLevel: 'L1',
    });
    expect(out).toMatchObject({ explainStatus: 'checked', explain: VERB_OBJECT });
    expect(calls).toEqual({ check: 2, why: 1 });
  });

  it('still failing after the regeneration: "We’re not sure about this one" (unsure, never practised)', async () => {
    const { llm } = fakeExplainLLM({ check: () => ({ ok: false, problem: 'wrong' }) });
    const [out] = await checkExplanations(llm, [ownerIssue], { text: OWNER, learnerLevel: 'L1' });
    expect(out!.explainStatus).toBe('unsure');
  });

  it('an unreachable checker leaves it pending (retried later), never checked', async () => {
    const { llm } = fakeExplainLLM({ offline: true });
    const [out] = await checkExplanations(llm, [ownerIssue], { text: OWNER, learnerLevel: 'L1' });
    expect(out!.explainStatus).toBe('pending');
  });

  it('a missing or unusable explanation is written before it is checked', async () => {
    expect(isUsableExplanation({ ...VERB_OBJECT, exampleRight: '我念软件' })).toBe(false); // simplified
    expect(isUsableExplanation({ ...VERB_OBJECT, exampleRight: VERB_OBJECT.exampleWrong })).toBe(false);
    const { llm, calls } = fakeExplainLLM({});
    const { explain: _e, ...bare } = ownerIssue;
    void _e;
    const [out] = await checkExplanations(llm, [bare], { text: OWNER, learnerLevel: 'L1' });
    expect(out!.explainStatus).toBe('checked');
    expect(out!.explain!.wrongEn.length).toBeGreaterThan(0);
    expect(calls.why).toBe(1);
  });

  it('every correction over the Phase 17 evaluation set ends with a non-empty, checked explanation (or unsure)', async () => {
    const file = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../test/fixtures/journal-cloze/sentences.v1.json', import.meta.url)),
        'utf8',
      ),
    ) as EvalFixtureFile;
    // one issue per fixture: the changed run between the original and the human correction
    const issues = file.entries.flatMap((e): { text: string; issue: JournalIssue }[] => {
      const a = e.original;
      const b = e.reference.corrected;
      if (a === b) return [];
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let s = 0;
      while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
      const span: [number, number] = [p, Math.max(p + 1, a.length - s)];
      return [
        {
          text: a,
          issue: {
            span,
            type: 'error',
            correction: b.slice(p, b.length - s) || b,
            explanationEn: 'x',
            confidence: 'high',
          },
        },
      ];
    });
    expect(issues.length).toBeGreaterThanOrEqual(30);
    // the checker rejects every third explanation on the first round
    const { llm } = fakeExplainLLM({
      check: (item, call) => ({ ok: call > 0 || item.correction.length % 3 !== 0, problem: 'not quite' }),
    });
    for (const { text, issue } of issues) {
      const [out] = await checkExplanations(llm, [issue], { text, learnerLevel: 'L1' });
      expect(['checked', 'unsure']).toContain(out!.explainStatus);
      if (out!.explainStatus === 'checked') {
        expect(isUsableExplanation(out!.explain)).toBe(true);
        expect(out!.explain!.wrongEn.trim()).not.toBe('');
      }
    }
  });
});

describe('alternatives keep the meaning (Part B)', () => {
  const verify: GapLLM['verifyJournalSentence'] = async (req) => ({
    ok: true,
    problem: '',
    // 念中文書 means "read Chinese books", not "study Chinese"
    meaningMatches: !req.zh.includes('中文書'),
  });

  it('念中文書 is shown with its meaning, never as "also a good option"', async () => {
    const alts = await checkAlternativeMeanings(
      { verifyJournalSentence: verify },
      {
        sentence: '我喜歡念書中文。',
        original: '書中文',
        intendedEn: 'I enjoy studying Chinese.',
        alternatives: [
          { zh: '中文書', meaningEn: 'read Chinese books' },
          { zh: '中文', meaningEn: 'study Chinese' },
        ],
      },
    );
    expect(alts).toEqual([
      { zh: '中文書', meaningEn: 'read Chinese books', sameMeaning: false },
      { zh: '中文', meaningEn: 'study Chinese', sameMeaning: true },
    ]);
    expect(alternativeLine(alts[0]!)).toBe('(中文書 = read Chinese books: a different meaning)');
    expect(alternativeLine(alts[1]!)).toBe('中文 also works');
  });

  it('an alternative the check could not see is dropped', async () => {
    const alts = await checkAlternativeMeanings(
      { verifyJournalSentence: async () => Promise.reject(new Error('offline')) },
      { sentence: '我喜歡念書中文。', original: '書中文', intendedEn: 'x', alternatives: [{ zh: '中文書', meaningEn: 'y' }] },
    );
    expect(alts).toEqual([]);
  });
});

describe('gap fills that fit the sentence (Part D)', () => {
  const w = (id: string, headword: string, glossEn: string, level: Word['level'], pinyin = ''): Word => ({
    id,
    headword,
    variants: [],
    pos: ['Vs'],
    level,
    source: 'tocfl',
    pinyin,
    pinyinNumeric: '',
    zhuyin: '',
    glossEn,
    chars: [...headword],
    tags: [],
  });
  const lexicon = new Lexicon([
    w('yiren', '宜人', 'nice; pleasant', 'L1', 'yírén'),
    w('qinqie', '親切', 'kind; nice; friendly', 'L3', 'qīnqiè'),
    w('hao', '好', 'good', 'N1', 'hǎo'),
    w('ren', '人', 'person', 'N1', 'rén'),
    w('hen', '很', 'very', 'N1', 'hěn'),
  ]);
  const gap = extractBrackets(OWNER)[0]!;

  it('the old rule’s blind pick: several lexicon words match "nice", 宜人 first', () => {
    expect(gapCandidates('nice', lexicon).map((x) => x.headword)).toEqual(['宜人', '親切']);
  });

  it('[nice] about a teacher gives 人很好 / 很親切 first; 宜人 fails the check for a person', async () => {
    const seen: string[] = [];
    const llm: GapLLM = {
      async fillJournalGap(req) {
        expect(req.sentence).toBe('我的老師很＿＿。');
        expect(req.candidates.map((c) => c.zh)).toEqual(['宜人', '親切']);
        return {
          options: [
            { zh: '人很好', pinyin: '', meaningEn: 'a good, kind person', usageEn: 'for people', corrected: '我的老師人很好。' },
            { zh: '親切', pinyin: 'qīn qiè', meaningEn: 'kind, warm', usageEn: 'for people', corrected: '我的老師很親切。' },
            { zh: '宜人', pinyin: 'yí rén', meaningEn: 'pleasant', usageEn: '宜人: pleasant, for weather or places, not people', corrected: '我的老師很宜人。' },
          ],
        };
      },
      async verifyJournalSentence(req) {
        seen.push(req.zh);
        return { ok: !req.zh.includes('宜人'), problem: '', meaningMatches: true };
      },
    };
    const options = await resolveGap(llm, lexicon, { text: OWNER, gap, learnerLevel: 'L1', intendedEn: 'My teacher is very nice.' });
    expect(options.map((o) => o.zh)).toEqual(['人很好', '親切']);
    expect(options[0]!.pinyin).toBe('rén hěn hǎo'); // readings from the lexicon (MOE)
    expect(options[1]).toMatchObject({ wordId: 'qinqie', checked: true });
    expect(seen).toContain('我的老師很宜人。');
  });

  it('with no model, the lexicon matches are listed as plain options (never checked, never added)', async () => {
    const options = await resolveGap(undefined, lexicon, { text: OWNER, gap, learnerLevel: 'L1' });
    expect(options.map((o) => [o.zh, o.checked])).toEqual([
      ['宜人', false],
      ['親切', false],
    ]);
  });
});

describe('helpers', () => {
  it('finds the sentence around a correction', () => {
    expect(contextAround(OWNER, at('書中文'))).toBe('我喜歡念書中文。');
    expect(sentenceRange(OWNER, at('老師'))).toEqual([8, OWNER.length]);
  });

  it('counts repeated mistakes of the same kind', () => {
    expect(sameMistakeCount('Verb-Object', [{ pattern: 'verb-object' }, { pattern: 'verb-object ' }, { pattern: '了' }])).toBe(2);
    expect(sameMistakeCount(undefined, [{ pattern: 'x' }])).toBe(0);
  });
});
