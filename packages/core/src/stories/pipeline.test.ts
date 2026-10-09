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
const req = { names: [], length: { min: 10, max: 400 } } as unknown as StoryRequest;
const PASS: StoryCheckResponse = { natural: true, coherent: true, taiwan: true, summaryMatches: true, problems: [], correctOptions: [[0], [0]] };

const run = (res: StoryResponse) =>
  runStoryPipeline({
    llm: { writeStory: async () => ({ story: res }), checkStory: async () => PASS } as never,
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

  it('mostly unknown words: still refused', () => {
    const a = { res: story(['x']), report: { failed: ['rung1', 'rung6'], rung1Share: 0.4, paragraphs: [] } } as never;
    expect(miniLessonGlosses(a, lexicon)).toBeUndefined();
  });

  it('a Taiwan-usage or question problem is never waved through', () => {
    const a = { res: story(['x']), report: { failed: ['rung6', 'taiwanness'], rung1Share: 0.9, paragraphs: [] } } as never;
    expect(miniLessonGlosses(a, lexicon)).toBeUndefined();
  });

  it('a word nobody can explain: refused', () => {
    const a = {
      res: story(['x']),
      report: { failed: ['rung6'], rung1Share: 0.9, paragraphs: [[{ text: '嘰咕', rung: 6 }]] },
    } as never;
    expect(miniLessonGlosses(a, lexicon)).toBeUndefined();
  });
});
