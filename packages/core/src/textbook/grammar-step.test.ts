import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { seededRng } from '../session/orderSession.js';
import {
  buildGrammarStep,
  checkGrammarAnswer,
  extraExercise,
  fillSlots,
  gradeTiles,
  patternBlank,
  reorderTiles,
  sentenceTiles,
  type GrammarSentence,
  type GrammarStepInputs,
} from './grammar-step.js';

const w = (headword: string, i: number): Word => ({
  id: `w${i}`,
  headword,
  variants: [],
  pos: [],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [...headword],
  tags: [],
});
const lexicon = new Lexicon(
  [
    '我', '你', '他', '忙', '累', '是', '不是', '老師', '學生', '的', '工作', '很', '呢', '爸爸', '媽媽', '喜歡',
    '有', '沒有', '哥哥', '吃飯', '點', '十一', '一點', '每天', '天才', '才', '睡覺', '看', '完', '了', '完了',
    '好看', '這', '本', '書', '不太', '太', '冷', '今天', '好', '從小', '小時候', '時候', '從', '就', '請', '進來', '進',
    '來', '個', '三', '在', '銀行', '叫', '姓',
  ].map(w),
  [],
);

describe('reorderTiles (Phase 25: number + measure word, scope-aware)', () => {
  it('a number and its measure word or time unit are one tile', () => {
    expect(reorderTiles('我十一點吃飯。', lexicon)).toEqual(['我', '十一點', '吃飯', '。']);
    expect(reorderTiles('他有三個哥哥。', lexicon)).toEqual(['他', '有', '三個', '哥哥', '。']);
  });

  it('never a word the learner cannot know yet (天才 in 每天才)', () => {
    const allowed = (h: string) => h !== '天才';
    expect(reorderTiles('我每天才睡覺。', lexicon, allowed)).toEqual(['我', '每天', '才', '睡覺', '。']);
  });

  it('a sentence-final particle is its own tile', () => {
    const lex = new Lexicon(['我', '叫', '家文', '您', '您呢'].map(w), []);
    expect(reorderTiles('我叫家文，您呢？', lex)).toEqual(['我', '叫', '家文', '，', '您', '呢', '？']);
  });

  it('a content override wins when it spells the sentence', () => {
    expect(sentenceTiles({ zh: '我每天才睡覺。', tiles: ['我', '每天', '才', '睡覺', '。'] }, lexicon)).toEqual(['我', '每天', '才', '睡覺', '。']);
    expect(sentenceTiles({ zh: '我每天才睡覺。', tiles: ['我', '睡覺'] }, lexicon)).toEqual(reorderTiles('我每天才睡覺。', lexicon));
  });

  it('a tie on tile count goes to backward matching (請/進來)', () => {
    expect(reorderTiles('請進來。', lexicon, (h) => h !== '進來' || true)).toEqual(['請', '進來', '。']);
  });
});

describe('fillSlots / gradeTiles: punctuation stays put, altOrders accepted', () => {
  const ex = { slots: [null, null, '，', null, null, '。'], accepted: ['今天我很忙，你呢。', '我今天很忙，你呢。'] };
  it('builds the sentence around the fixed punctuation', () => {
    expect(fillSlots(ex.slots, ['今天我', '很忙', '你', '呢'])).toBe('今天我很忙，你呢。');
  });
  it('accepts any listed order', () => {
    expect(gradeTiles(ex, ['我今天', '很忙', '你', '呢'])).toBe(true);
    expect(gradeTiles(ex, ['很忙', '我今天', '你', '呢'])).toBe(false);
  });
});

describe('patternBlank: the blank comes from the matcher span, and the word standing alone', () => {
  it('blanks the 太 of 太…了, not the 太 of 不太', () => {
    expect(patternBlank('今天不太冷，太好了！', { focus: ['太'], matcher: '太[^，。？！]+了' }, lexicon)).toEqual({ at: 6, answer: '太' });
  });
  it('blanks the 看 that stands alone, not the one in 好看', () => {
    expect(patternBlank('這本書很好看，我看了。', { focus: ['看'], matcher: '看' }, lexicon)?.at).toBe(8);
  });
  it('blanks the 是 of 是…的, not the one in 不是', () => {
    const zh = '他不是老師，他是昨天來的。';
    expect(patternBlank(zh, { focus: ['是'], matcher: '是[^，。？！]{1,14}的[。？！]?$' }, lexicon)?.at).toBe(zh.lastIndexOf('是'));
  });
  it('nothing to blank for a point with no signal word', () => {
    expect(patternBlank('你忙不忙？', { focus: [] }, lexicon)).toBeUndefined();
  });
});

const sentences: GrammarSentence[] = [
  { id: 'a1', zh: '你忙不忙？', en: 'Are you busy?', grammarIds: ['g-anota'], wrong: '你忙不忙嗎？' },
  { id: 'a2', zh: '你累不累？', en: 'Are you tired?', grammarIds: ['g-anota'] },
  { id: 'a3', zh: '你是不是老師？', en: 'Are you a teacher?', grammarIds: ['g-anota'] },
  { id: 'a4', zh: '他是不是學生？', en: 'Is he a student?', grammarIds: ['g-anota'] },
  { id: 'n1', zh: '我很忙，你呢？', en: "I'm busy. And you?", grammarIds: ['g-ne'], wrong: '我很忙，呢你？' },
  { id: 'n2', zh: '我是老師，你呢？', en: "I'm a teacher. And you?", grammarIds: ['g-ne'] },
  { id: 'n3', zh: '我在銀行工作，你呢？', en: 'I work at a bank. And you?', grammarIds: ['g-ne'] },
  { id: 'n4', zh: '我叫明文，你呢？', en: "I'm Mingwen. And you?", grammarIds: ['g-ne'] },
  { id: 'd1', zh: '我爸爸的工作很忙。', en: "My dad's job is busy.", grammarIds: ['g-de'] },
  { id: 'd2', zh: '他的媽媽是老師。', en: 'His mother is a teacher.', grammarIds: ['g-de'] },
  { id: 'd3', zh: '我媽媽喜歡她的工作。', en: 'My mom likes her job.', grammarIds: ['g-de'] },
  { id: 'd4', zh: '你的老師很忙。', en: 'Your teacher is busy.', grammarIds: ['g-de'] },
];
const inputs = (seed: string): GrammarStepInputs => ({
  grammarIds: ['g-anota', 'g-ne', 'g-de'],
  grammarItems: [
    { id: 'g-anota', focus: [], matcher: '(.)不\\1' },
    { id: 'g-ne', focus: ['呢'], matcher: '呢' },
    { id: 'g-de', focus: ['的'], matcher: '的' },
  ],
  sentences,
  lexicon,
  pool: ['呢', '的', '嗎', '也', '都', '姓', '叫'],
  rng: seededRng(seed),
});

describe('buildGrammarStep (Phase 25 Part B)', () => {
  it('3 exercises per point, each on a different sentence, round-robin, never a dropped point', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const { exercises } = buildGrammarStep(inputs(seed));
      expect(exercises.map((e) => e.grammarId)).toEqual(['g-anota', 'g-ne', 'g-de', 'g-anota', 'g-ne', 'g-de', 'g-anota', 'g-ne', 'g-de']);
      expect(new Set(exercises.map((e) => e.sentenceId)).size).toBe(9);
      for (const g of ['g-anota', 'g-ne', 'g-de']) {
        const types = new Set(exercises.filter((e) => e.grammarId === g).map((e) => e.type));
        expect(types.size, `${seed} ${g}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('the same seed builds the same step', () => {
    expect(buildGrammarStep(inputs('x')).exercises).toEqual(buildGrammarStep(inputs('x')).exercises);
  });

  it('a point with no signal word is not reorder-only', () => {
    const types = buildGrammarStep(inputs('y')).exercises.filter((e) => e.grammarId === 'g-anota').map((e) => e.type);
    expect(types.some((t) => t !== 'reorder')).toBe(true);
  });

  it('a build exercise has exactly one distractor tile', () => {
    for (const seed of ['a', 'b', 'c', 'd']) {
      for (const e of buildGrammarStep(inputs(seed)).exercises) {
        if (e.type !== 'build') continue;
        expect(e.distractor).toBeDefined();
        expect(e.tiles.filter((t) => t === e.distractor)).toHaveLength(1);
        expect(e.zh).not.toContain(e.distractor!);
        // right answer = the movable tiles without the distractor, in order
        const right = e.slots.length;
        expect(right).toBeGreaterThan(0);
      }
    }
  });

  it('a miss comes back with a DIFFERENT sentence for the same point', () => {
    const inp = inputs('z');
    const plan = buildGrammarStep(inp);
    for (const missed of plan.exercises) {
      const extra = extraExercise(plan, missed, inp, new Set(plan.exercises.map((e) => e.sentenceId)));
      expect(extra?.grammarId).toBe(missed.grammarId);
      expect(extra?.sentenceId).not.toBe(missed.sentenceId);
    }
  });

  it('checkGrammarAnswer grades every type', () => {
    const { exercises } = buildGrammarStep(inputs('q'));
    for (const e of exercises) {
      if (e.type === 'fill') {
        expect(checkGrammarAnswer(e, e.answer)).toBe(true);
        expect(checkGrammarAnswer(e, e.options.find((o) => o !== e.answer)!)).toBe(false);
      } else if (e.type === 'pick') {
        expect(checkGrammarAnswer(e, e.correctIndex)).toBe(true);
        expect(checkGrammarAnswer(e, 1 - e.correctIndex)).toBe(false);
      } else {
        const tiles = reorderTiles(e.zh, lexicon).filter((t) => !/^[，。？！]+$/.test(t));
        expect(checkGrammarAnswer(e, tiles)).toBe(true);
        expect(checkGrammarAnswer(e, [...tiles].reverse())).toBe(false);
      }
    }
  });
});
