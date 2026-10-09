import { describe, expect, it } from 'vitest';
import { Lexicon, type GrammarItem, type SentenceBankEntry, type Word } from '@anan/core';
import { buildLessonGrammarStep } from './textbook-session.js';

const g = (id: string, lesson: number, focus: string[], matcher?: string): GrammarItem => ({
  id,
  pattern: id,
  level: 'N1',
  explanationEn: '',
  examples: [],
  tags: ['textbook:laixue-1', `textbook:laixue-1:L${String(lesson).padStart(2, '0')}`],
  focus,
  ...(matcher ? { matcher } : {}),
});
const s = (id: string, zh: string, lesson: number, grammarIds: string[], extra: Partial<SentenceBankEntry> = {}): SentenceBankEntry => ({
  id,
  zh,
  en: zh,
  targetWordId: 'w',
  level: 'N1',
  tokens: [],
  source: 'generated',
  doubtful: false,
  lesson,
  grammarIds,
  ...extra,
});
const word = (headword: string, i: number): Word => ({
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
  ['他們', '都', '是', '學生', '臺灣人', '老師', '我', '不', '也', '你', '忙', '累', '好', '很', '朋友', '我們', '喝', '茶', '吃飯'].map(word),
);

const items = [g('gram-dou-all', 3, ['都'], '都'), g('gram-ye-also', 2, ['也'], '也'), g('gram-bu', 3, ['不'], '不')];
const sentences = [
  s('1', '他們都是學生。', 3, ['gram-dou-all'], { wrong: '都他們是學生。' }),
  s('2', '他們都是臺灣人。', 3, ['gram-dou-all']),
  s('3', '我們都是老師。', 3, ['gram-dou-all']),
  s('4', '我們都很好。', 3, ['gram-dou-all']),
  s('5', '我不是學生。', 3, ['gram-bu'], { wrong: '我是不學生。' }),
  s('6', '他們不是老師。', 3, ['gram-bu']),
  s('7', '我不喝茶。', 3, ['gram-bu']),
  s('8', '你不忙。', 2, ['gram-bu']),
  s('9', '我也是學生。', 2, ['gram-ye-also']),
];

describe('buildLessonGrammarStep (Phase 25)', () => {
  it("3 per point from this lesson's sentences, round-robin, every sentence different", () => {
    const { plan } = buildLessonGrammarStep({ n: 3, grammar: ['gram-dou-all', 'gram-bu'] }, items, sentences, { lexicon, seed: 'a' });
    expect(plan.exercises.map((e) => e.grammarId)).toEqual(['gram-dou-all', 'gram-bu', 'gram-dou-all', 'gram-bu', 'gram-dou-all', 'gram-bu']);
    expect(new Set(plan.exercises.map((e) => e.sentenceId)).size).toBe(6);
    expect(plan.exercises.every((e) => ['1', '2', '3', '4', '5', '6', '7'].includes(e.sentenceId))).toBe(true);
  });

  it('reported sentences never come back', () => {
    const { plan } = buildLessonGrammarStep({ n: 3, grammar: ['gram-bu'] }, items, sentences, {
      lexicon,
      seed: 'b',
      excluded: new Set(['我不喝茶。']),
    });
    expect(plan.exercises.map((e) => e.sentenceId).sort()).toEqual(['5', '6']);
  });

  it('fill distractors are signal words of this lesson and earlier', () => {
    for (const seed of ['c', 'd', 'e']) {
      const { plan } = buildLessonGrammarStep({ n: 3, grammar: ['gram-dou-all', 'gram-bu'] }, items, sentences, { lexicon, seed });
      for (const e of plan.exercises) if (e.type === 'fill') expect(e.options.every((o) => ['都', '也', '不'].includes(o))).toBe(true);
    }
  });

  it('the same seed builds the same step', () => {
    const a = buildLessonGrammarStep({ n: 3, grammar: ['gram-dou-all', 'gram-bu'] }, items, sentences, { lexicon, seed: 'x' });
    const b = buildLessonGrammarStep({ n: 3, grammar: ['gram-dou-all', 'gram-bu'] }, items, sentences, { lexicon, seed: 'x' });
    expect(a.plan.exercises).toEqual(b.plan.exercises);
  });
});
