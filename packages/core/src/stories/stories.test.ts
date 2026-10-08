import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import type { Word } from '../types.js';
import type { VocabLadder, VocabRung } from '../progress/vocabLadder.js';
import {
  analyzeStory,
  checkStoryQuestions,
  hanCount,
  pickBestStoryAttempt,
  rereadSuggestions,
  storyBudget,
  storyCheckPasses,
  storyFeedback,
  storyNewWords,
  storyPromptRungs,
  storyRecord,
  storyRequestKey,
  storyAllowedNames,
  storySentences,
  segmentWithNames,
  type StoryQuestion,
  type StoryRecord,
  type StoryRequest,
} from './index.js';

let n = 0;
const w = (headword: string, level: Level | null, glossEn: string, tags: string[] = []): Word => ({
  id: `s${++n}-${headword}`,
  headword,
  variants: [],
  pos: ['N'],
  level,
  source: level ? 'tocfl' : 'supplement',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags,
});

// rung 1 words, then one word for each of rungs 2–5
const R1 = ['我', '我們', '坐', '你', '他', '去', '喝', '茶', '很', '好', '今天', '朋友', '一起', '吃', '飯', '想', '買', '東西', '在', '說', '看', '店'];
const WORDS = [
  ...R1.map((h) => w(h, 'N1', `gloss ${h}`)),
  w('咖啡', 'N1', 'coffee'), // rung 2
  w('便利商店', 'N1', 'convenience store'), // rung 3
  w('捷運', 'N1', 'MRT'), // rung 4
  w('機車', 'N1', 'scooter'), // rung 5
  w('垃圾車', 'L1', 'garbage truck'), // rung 6
  w('飲料', 'N1', 'drink; beverage'), // rung 1, a swap for 咖啡-like words
  w('了', null, 'particle', ['particle']),
  w('嗎', null, 'particle', ['particle']),
  w('王', null, 'Wang', ['name']),
];
const byHw = new Map(WORDS.map((x) => [x.headword, x]));
const id = (h: string) => byHw.get(h)!.id;
const lexicon = new Lexicon(WORDS, []);

const RUNG: Record<string, VocabRung> = { 咖啡: 2, 便利商店: 3, 捷運: 4, 機車: 5 };
const ids = (r: VocabRung) => new Set(WORDS.filter((x) => (RUNG[x.headword] ?? (x.level === 'N1' ? 1 : 6)) === r).map((x) => x.id));
const ladder: VocabLadder = {
  rung: (wid) => {
    const x = WORDS.find((y) => y.id === wid);
    if (!x) return 6;
    return RUNG[x.headword] ?? (x.level === 'N1' ? 1 : 6);
  },
  ids: { 1: ids(1), 2: ids(2), 3: ids(3), 4: ids(4), 5: ids(5) },
  source: 'study-order',
  lessons: {},
  upcomingWordIds: [],
  grammar: { allowed: [], next: [], upcoming: [] },
  properNounIds: [],
};
const ctx = { ladder, lexicon, allowedTexts: new Set(['王']) };

/** 20 rung 1 tokens, plus whatever is added. */
const base = '我今天想去店。你很好。他喝茶。我們一起吃飯。朋友說：你想買東西嗎？我看他。';

describe('graded story validation (Phase 24)', () => {
  it('counts rung shares by content token; names, particles and punctuation never count', () => {
    const r = analyzeStory([`王${base}他喝了咖啡。咖啡很好。`], ctx);
    expect(r.counts[2]).toBe(2);
    expect(r.distinct[2]).toEqual([id('咖啡')]);
    expect(r.paragraphs[0]!.find((t) => t.text === '王')?.rung).toBe('allowed');
    expect(r.paragraphs[0]!.find((t) => t.text === '了')?.rung).toBe('allowed');
    expect(r.rung1Share).toBeGreaterThan(0.9);
    expect(r.pass).toBe(true);
  });

  it('rung 3 ≤ 3 words, rung 4 ≤ 1, rung 5 ≤ 1, rung 6 = 0 unless glossed', () => {
    const ok = analyzeStory([`${base}${base}他去便利商店，坐捷運，看機車。`], ctx);
    expect(ok.failed).toEqual([]);
    const r6 = analyzeStory([`${base}${base}他看垃圾車。`], ctx);
    expect(r6.failed).toContain('rung6');
    const glossed = analyzeStory([`${base}${base}他看垃圾車。`], { ...ctx, glossed: new Set(['垃圾車']) });
    expect(glossed.failed).toEqual([]);
    const tooMany4 = analyzeStory([`${base}${base}${base}捷運。`], { ...ctx, ladder: { ...ladder, rung: (x) => (x === id('捷運') || x === id('機車') ? 4 : ladder.rung(x)) } });
    expect(tooMany4.failed).toEqual([]);
    const two4 = analyzeStory([`${base}${base}${base}捷運，機車。`], { ...ctx, ladder: { ...ladder, rung: (x) => (x === id('捷運') || x === id('機車') ? 4 : ladder.rung(x)) } });
    expect(two4.failed).toContain('rung4');
  });

  it('rung 1 below 90% fails, and the feedback names the words with rung 1 swaps', () => {
    const r = analyzeStory(['我喝咖啡。咖啡很好。你喝咖啡。'], ctx);
    expect(r.failed).toContain('rung1');
    const fb = storyFeedback(r, storyBudget('middle'), { ladder, lexicon });
    expect(fb).toMatch(/rung 1/);
  });

  it('Easier / Harder change the shares (the budget function)', () => {
    const mid = storyBudget('middle');
    const easy = storyBudget('easier');
    const hard = storyBudget('harder');
    expect(mid).toMatchObject({ minRung1Share: 0.9, maxRung3Words: 3, maxRung4Words: 1, maxRung5Words: 1 });
    expect(easy.minRung1Share).toBeGreaterThanOrEqual(0.97);
    expect(easy.maxRung4Words + easy.maxRung5Words + easy.maxRung6Glossed).toBe(0);
    expect(hard.maxRung3Words).toBe(mid.maxRung3Words * 2);
    expect(hard.maxRung4Words).toBe(mid.maxRung4Words * 2);
    expect(hard.maxRung5Words).toBe(mid.maxRung5Words * 2);
    // the same story passes Middle and fails Easier
    const story = [`${base}${base}他坐捷運。`];
    expect(analyzeStory(story, ctx, mid).pass).toBe(true);
    expect(analyzeStory(story, ctx, easy).failed).toContain('rung4');
  });

  it('simplified characters or mainland terms in any sentence fail', () => {
    const r = analyzeStory([`${base}我们一起吃饭。`], ctx);
    expect(r.failed).toContain('taiwanness');
    expect(r.taiwanness).toHaveLength(1);
  });

  it('length is checked against the level target (with slack)', () => {
    expect(analyzeStory([base], ctx, storyBudget(), { min: 400, max: 700 }).failed).toContain('length');
    expect(analyzeStory([base], ctx, storyBudget(), { min: 30, max: 60 }).failed).not.toContain('length');
    expect(hanCount('我，你！ab')).toBe(2);
    expect(storySentences('我很好。你呢？他說：「好！」')).toEqual(['我很好。', '你呢？', '他說：「好！」']);
  });

  it('a story character stays one token and is allowed; an ordinary word cannot pose as a character', () => {
    const names = storyAllowedNames(['王'], ['小美', '咖啡', 'Amy'], lexicon);
    expect([...names].sort()).toEqual(['小美', '王'].sort());
    expect(segmentWithNames('小美喝茶。', lexicon, names).map((t) => t.text)).toEqual(['小美', '喝', '茶', '。']);
    const r = analyzeStory([`小美${base}`], { ...ctx, allowedTexts: names });
    expect(r.paragraphs[0]![0]).toMatchObject({ text: '小美', rung: 'allowed' });
    expect(r.pass).toBe(true);
  });

  it('the best attempt is the one that passes, then the one breaking fewest limits', () => {
    const a = { report: analyzeStory(['我喝咖啡。咖啡很好。'], ctx) };
    const b = { report: analyzeStory([`${base}${base}`], ctx) };
    expect(pickBestStoryAttempt([a, b])).toBe(b);
  });
});

const q = (answer: number, opts = ['茶', '咖啡', '飯']): StoryQuestion => ({
  q_zh: '他喝什麼？',
  q_en: 'What does he drink?',
  options: opts.map((zh) => ({ zh, en: zh })),
  answer,
});

describe('comprehension questions', () => {
  it('each question has exactly one correct option (fixture + independent check)', () => {
    expect(checkStoryQuestions([q(0), q(1)]).ok).toBe(true);
    // the checker agrees with the answers
    expect(checkStoryQuestions([q(0), q(1)], { correctOptions: [[0], [1]] }).questions).toHaveLength(2);
    // two right options, or a different one: the question is dropped
    const c = checkStoryQuestions([q(0), q(1), q(2)], { correctOptions: [[0, 2], [1], [0]] });
    expect(c.questions).toHaveLength(1);
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/Question 1/);
  });

  it('malformed questions are dropped: duplicate options, answer out of range, too few options', () => {
    const c = checkStoryQuestions([q(0, ['茶', '茶', '飯']), q(5), q(0, ['茶', '飯']), q(1), q(2)]);
    expect(c.questions).toHaveLength(2);
    expect(c.ok).toBe(true);
  });

  it('at most 4 are kept', () => {
    expect(checkStoryQuestions([q(0), q(1), q(2), q(0), q(1)]).questions).toHaveLength(4);
  });

  it('the independent reader must approve naturalness, coherence, Taiwan usage and the summary', () => {
    const ok = { natural: true, coherent: true, taiwan: true, summaryMatches: true, problems: [], correctOptions: [] };
    expect(storyCheckPasses(ok)).toBe(true);
    expect(storyCheckPasses({ ...ok, summaryMatches: false })).toBe(false);
  });
});

describe('library helpers', () => {
  const req: StoryRequest = {
    topic: 'tea',
    learnerLevel: 'N1',
    length: { min: 80, max: 150 },
    rungs: { r1: ['我', '你'], r2: ['咖啡'], r3: [], r4: [], r5: [] },
    budget: { rung1Share: 0.95, rung3: 3, rung4: 1, rung5: 1 },
    grammar: [],
    grammarNext: [],
    names: [],
  };

  it('the same request has the same key (list order and feedback ignored); a variant differs', () => {
    expect(storyRequestKey(req)).toBe(storyRequestKey({ ...req, rungs: { ...req.rungs, r1: ['你', '我'] } }));
    expect(storyRequestKey({ ...req, variant: 1 })).not.toBe(storyRequestKey(req));
  });

  it('prompt lists: due words lead rung 1, rungs 2–4 complete', () => {
    const lists = storyPromptRungs({ ladder, lexicon, dueIds: new Set([id('店')]), rng: () => 0.5 });
    expect(lists.r1[0]).toBe('店');
    expect(lists.r2).toEqual(['咖啡']);
    expect(lists.r3).toEqual(['便利商店']);
    expect(lists.r4).toEqual(['捷運']);
  });

  it('a record keeps the rung 2–6 words to underline, and re-reading is suggested once they are known', () => {
    const report = analyzeStory([`${base}他喝咖啡，去便利商店。`], ctx);
    expect(storyNewWords(report).map((x) => x.text)).toEqual(['咖啡', '便利商店']);
    const res = {
      title_zh: '喝茶',
      title_en: 'Tea',
      paragraphs: [{ zh: `${base}他喝咖啡，去便利商店。`, en: '...' }],
      summary_en: 'Tea.',
      glosses: [],
      characters: ['王'],
      questions: [q(0), q(1)],
    };
    const old = new Date('2026-09-01');
    const rec: StoryRecord = {
      ...storyRecord(res, report, res.questions, { id: 'story-x', level: 'N1', difficulty: 'middle', topic: 'tea', lessonId: undefined }, old),
      readAt: old,
    };
    expect(rec.lessonId).toBeUndefined();
    const now = new Date('2026-10-08');
    expect(rereadSuggestions([rec], new Set(), now)).toEqual([]);
    expect(rereadSuggestions([rec], new Set(rec.wordIds), now)).toEqual([rec]);
    expect(rereadSuggestions([{ ...rec, readAt: new Date('2026-10-01') }], new Set(rec.wordIds), now)).toEqual([]);
  });
});
