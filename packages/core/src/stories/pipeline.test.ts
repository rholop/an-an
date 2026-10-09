import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import type { VocabLadder, VocabRung } from '../progress/vocabLadder.js';
import { miniLessonGlosses, runStoryPipeline } from './pipeline.js';
import type { StoryCheckResponse, StoryRequest, StoryResponse } from './types.js';

const w = (headword: string, glossEn: string, i: number): Word => ({
  id: `p${i}`,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags: [],
});
const KNOWN = ['他', '是', '老師', '我', '很', '忙', '在', '學校', '工作', '你', '好', '今天', '不', '學生', '的', '也'];
const NEW = ['公司', '太太'];
const words = [...KNOWN, ...NEW].map((h, i) => w(h, h === '公司' ? 'company' : h === '太太' ? 'wife; Mrs.' : h, i));
const lexicon = new Lexicon(words, []);
const known = new Set(words.filter((x) => KNOWN.includes(x.headword)).map((x) => x.id));
const ladder = { rung: (id: string): VocabRung => (known.has(id) ? 1 : 6), ids: { 1: known, 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set() } } as unknown as VocabLadder;

const story = (zh: string[]): StoryResponse => ({
  title_zh: '我的老師',
  title_en: 'My teacher',
  summary_en: 'About a teacher.',
  paragraphs: zh.map((p) => ({ zh: p, en: p })),
  glosses: [],
  characters: [],
  questions: [
    { q_zh: '他是老師嗎？', q_en: '', options: [{ zh: '是', en: '' }, { zh: '不是', en: '' }, { zh: '不知道', en: '' }], answer: 0 },
    { q_zh: '他忙不忙？', q_en: '', options: [{ zh: '很忙', en: '' }, { zh: '不忙', en: '' }, { zh: '不知道', en: '' }], answer: 0 },
  ],
});
const req = { names: [], learnerLevel: 'N1', length: { min: 10, max: 400 }, rungs: { r1: KNOWN, r2: [], r3: [], r4: [], r5: [] } } as unknown as StoryRequest;
const PASS: StoryCheckResponse = { natural: true, coherent: true, taiwan: true, summaryMatches: true, problems: [], correctOptions: [[0], [0]] };

const run = (res: StoryResponse) =>
  runStoryPipeline({
    llm: {
      writeStory: async () => ({ story: res }),
      checkStory: async () => PASS,
      repairStory: async () => ({ sentences: [], paragraphsEn: [], newWords: [] }),
    } as never,
    req,
    ladder,
    lexicon,
    difficulty: 'middle',
  });

describe('Phase 25: a story that misses only the word budgets is a mini lesson', () => {
  it('shown, every new word explained from the lexicon', async () => {
    const out = await run(story(['他是老師，他在學校工作。他的太太在公司工作。', '今天他很忙，太太也很忙。']));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.miniLesson).toBe(true);
    expect(out.story.glosses).toEqual(expect.arrayContaining([{ zh: '太太', en: 'wife; Mrs.' }, { zh: '公司', en: 'company' }]));
  });

  it('the floor depends on the difficulty (Middle 80%, Easier 88%)', () => {
    const a = { res: story(['x']), report: { failed: ['rung1'], rung1Share: 0.85, knownShare: 0.85, paragraphs: [] } } as never;
    expect(miniLessonGlosses(a, lexicon, 'middle')).toEqual([]);
    expect(miniLessonGlosses(a, lexicon, 'easier')).toBeUndefined();
  });

  it('mostly unknown words: still refused', () => {
    const a = { res: story(['x']), report: { failed: ['rung1', 'rung6'], rung1Share: 0.4, knownShare: 0.4, paragraphs: [] } } as never;
    expect(miniLessonGlosses(a, lexicon)).toBeUndefined();
  });

  it('a Taiwan-usage or question problem is never waved through', () => {
    const a = { res: story(['x']), report: { failed: ['rung6', 'taiwanness'], rung1Share: 0.9, knownShare: 0.9, paragraphs: [] } } as never;
    expect(miniLessonGlosses(a, lexicon)).toBeUndefined();
  });

  it('a word nobody can explain: refused', () => {
    const a = {
      res: story(['x']),
      report: { failed: ['rung6'], rung1Share: 0.9, knownShare: 0.9, paragraphs: [[{ text: '嘰咕', rung: 6 }]] },
    } as never;
    expect(miniLessonGlosses(a, lexicon)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 26 acceptance

import { analyzeStory, applyStoryRepair, storyBudget, storyRepairRequest, storySentenceRefs } from './index.js';
import type { StoryRepairRequest, StoryRepairResponse } from './types.js';

const P26_KNOWN = ['我', '我們', '他', '是', '很', '在', '去', '吃', '喝', '有', '好', '今天', '朋友', '家', '說', '想', '看', '的', '也', '茶', '飯', '大', '小', '人', '多', '都'];
const P26_LESSON = ['咖啡', '麵包'];
const P26_OTHER = ['公園', '跑步'];
const p26Words = [...P26_KNOWN, ...P26_LESSON, ...P26_OTHER].map((h, i) =>
  w(h, h === '公園' ? 'park' : h === '跑步' ? 'to run' : h === '咖啡' ? 'coffee' : h === '麵包' ? 'bread' : h, 100 + i),
);
const p26Lex = new Lexicon(p26Words, []);
const idOf = (h: string) => p26Words.find((x) => x.headword === h)!.id;
const rungOf = (h: string): VocabRung => (P26_KNOWN.includes(h) ? 1 : P26_LESSON.includes(h) ? 2 : 6);
const p26Ladder = {
  rung: (id: string): VocabRung => rungOf(p26Words.find((x) => x.id === id)?.headword ?? ''),
  ids: {
    1: new Set(P26_KNOWN.map(idOf)),
    2: new Set(P26_LESSON.map(idOf)),
    3: new Set(),
    4: new Set(),
    5: new Set(),
  },
} as unknown as VocabLadder;
const p26Req = {
  names: [],
  learnerLevel: 'N1',
  length: { min: 30, max: 120 },
  rungs: { r1: P26_KNOWN, r2: P26_LESSON, r3: [], r4: [], r5: [] },
} as unknown as StoryRequest;

/** A fake writer that counts every call. */
function countingLLM(write: (n: number) => StoryResponse, opts: { check?: Partial<StoryCheckResponse>; repair?: (r: StoryRepairRequest) => StoryRepairResponse } = {}) {
  const calls = { write: 0, repair: 0, check: 0, requests: [] as StoryRequest[] };
  return {
    calls,
    llm: {
      writeStory: async (r: StoryRequest) => {
        calls.requests.push(r);
        return { story: write(calls.write++) };
      },
      repairStory: async (r: StoryRepairRequest) => {
        calls.repair++;
        return opts.repair ? opts.repair(r) : { sentences: [], paragraphsEn: [], newWords: [] };
      },
      checkStory: async () => {
        calls.check++;
        return { ...PASS, ...opts.check };
      },
    },
  };
}
const runP26 = (llm: ReturnType<typeof countingLLM>['llm']) =>
  runStoryPipeline({ llm, req: p26Req, ladder: p26Ladder, lexicon: p26Lex, difficulty: 'middle' });

// The owner's case: two lesson words used 3 times each, one unexplained everyday word (公園), 88%+ known.
const OWNER = [
  '我今天很想喝咖啡。我去朋友家，朋友也想喝咖啡。',
  '他說：「我家有咖啡，也有麵包。」我們吃麵包，喝茶。',
  '今天我們去公園。麵包很好吃，朋友很好。',
];

describe('Phase 26: stories you can actually read', () => {
  it("owner's case: never refused; the unexplained word is repaired or taught first", async () => {
    const report = analyzeStory(OWNER, { ladder: p26Ladder, lexicon: p26Lex });
    expect(report.knownShare).toBeGreaterThan(0.88);
    expect(report.failed).toEqual(['rung6']);
    // A writer whose repairs change nothing (the worst case): shown as a mini lesson.
    const stuck = countingLLM(() => story(OWNER));
    const out = await runP26(stuck.llm);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.miniLesson).toBe(true);
    expect(out.story.glosses).toContainEqual({ zh: '公園', en: 'park' });
    // A writer that follows the repair: the story passes outright.
    const fixes = countingLLM(() => story(OWNER), {
      repair: (r) => ({ sentences: r.sentences.map((s) => ({ i: s.i, zh: s.zh.replace('去公園', '去朋友家') })), paragraphsEn: [], newWords: [] }),
    });
    const fixed = await runP26(fixes.llm);
    expect(fixed.ok && !fixed.miniLesson).toBe(true);
    expect(fixes.calls.repair).toBe(1);
  });

  it('contradiction gone: rung 2 words used twice each still pass', () => {
    const r = analyzeStory(['我想喝咖啡，朋友也想喝咖啡。我們吃麵包，麵包很好。'], { ladder: p26Ladder, lexicon: p26Lex });
    expect(r.counts[2]).toBe(4);
    expect(r.pass).toBe(true);
  });

  it('repair touches only the bad sentences: every other sentence is byte-identical', () => {
    const res = story(OWNER);
    const report = analyzeStory(OWNER, { ladder: p26Ladder, lexicon: p26Lex });
    const rq = storyRepairRequest(res, report, storyBudget('middle'), { req: p26Req, ladder: p26Ladder, lexicon: p26Lex })!;
    expect(rq.sentences.map((s) => s.zh)).toEqual(['今天我們去公園。']);
    expect(rq.sentences[0]!.problems[0]).toMatchObject({ zh: '公園', en: 'park' });
    // The writer tries to sneak a change into another sentence too: it is ignored.
    const out = applyStoryRepair(
      res,
      { sentences: [{ i: rq.sentences[0]!.i, zh: '今天我們在家。' }, { i: 0, zh: '我不想喝咖啡。' }], paragraphsEn: [], newWords: [] },
      new Set(rq.sentences.map((s) => s.i)),
    );
    const before = storySentenceRefs(OWNER).map((s) => s.zh);
    const after = storySentenceRefs(out.paragraphs.map((p) => p.zh)).map((s) => s.zh);
    expect(after).toHaveLength(before.length);
    before.forEach((s, i) => {
      if (i === rq.sentences[0]!.i) expect(after[i]).toBe('今天我們在家。');
      else expect(after[i]).toBe(s);
    });
    expect(out.paragraphs[0]).toBe(res.paragraphs[0]); // untouched paragraphs are the same objects
  });

  it('hard rules: a simplified character, an unnatural check or a story below the floor is never shown', async () => {
    const simp = countingLLM(() => story(['我们今天很想喝咖啡。我去朋友家，朋友也想喝咖啡。', ...OWNER.slice(1)]));
    expect((await runP26(simp.llm)).ok).toBe(false);
    const unnatural = countingLLM(() => story(OWNER), { check: { natural: false, problems: ['awkward'] } });
    expect((await runP26(unnatural.llm)).ok).toBe(false);
    const low = countingLLM(() => story(['公園跑步，公園跑步。我去公園跑步。']));
    const out = await runP26(low.llm);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reasons).toContain('rung1');
  });

  it('quota: at most 3 writing / repair calls and 1 check per story', async () => {
    for (const make of [() => story(['公園跑步，公園跑步。我去公園跑步。']), () => story(OWNER), () => story(['我很好。'])]) {
      const c = countingLLM(make);
      const out = await runP26(c.llm);
      expect(c.calls.write + c.calls.repair).toBeLessThanOrEqual(3);
      expect(c.calls.check).toBeLessThanOrEqual(1);
      expect(out.calls).toBe(c.calls.write + c.calls.repair);
    }
  });

  it('rewrites after the first try skip the proxy cache', async () => {
    const c = countingLLM(() => story(['公園跑步，公園跑步。我去公園跑步。']));
    await runP26(c.llm);
    expect(c.calls.requests[0]!.fresh).toBeUndefined();
    expect(c.calls.requests.slice(1).every((r) => r.fresh === true && !!r.feedback)).toBe(true);
    expect(c.calls.requests[1]!.feedback).toMatch(/公園 \(in none of your lists/);
  });
});
