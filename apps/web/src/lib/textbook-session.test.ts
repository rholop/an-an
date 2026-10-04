import { describe, expect, it } from 'vitest';
import type { GrammarItem, SentenceBankEntry } from '@anan/core';
import { buildGrammarExercises } from './textbook-session.js';

const g = (id: string, lesson: number, focus: string[]): GrammarItem => ({
  id,
  pattern: id,
  level: 'N1',
  explanationEn: '',
  examples: [],
  tags: ['textbook:laixue-1', `textbook:laixue-1:L${String(lesson).padStart(2, '0')}`],
  focus,
});
const s = (id: string, zh: string, lesson: number, grammarIds: string[]): SentenceBankEntry => ({
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
});

const items = [
  g('gram-dou-all', 3, ['都']),
  g('gram-ye-also', 2, ['也']),
  g('gram-bu', 3, ['不']),
  g('gram-a-not-a', 4, []),
];
const sentences = [
  s('1', '他們都是學生。', 3, ['gram-dou-all']),
  s('2', '他們都是臺灣人。', 3, ['gram-dou-all']),
  s('3', '我不是學生。', 3, ['gram-bu']),
  s('4', '你忙不忙？', 4, ['gram-a-not-a']),
  s('5', '我也是學生。', 2, ['gram-ye-also']),
];

describe('buildGrammarExercises', () => {
  it("covers each grammar point of the lesson using only that lesson's sentences", () => {
    const ex = buildGrammarExercises(
      { n: 3, grammar: ['gram-dou-all', 'gram-bu'] },
      items,
      sentences,
      { rng: () => 0.5 },
    );
    const ids = new Set(ex.map((e) => e.grammarId));
    expect(ids).toEqual(new Set(['gram-dou-all', 'gram-bu']));
    for (const e of ex) {
      const sid = e.type === 'cloze' ? e.sentenceId : e.sentenceId;
      expect(['1', '2', '3']).toContain(sid);
    }
  });

  it('offers a reorder for a pattern with no signal word', () => {
    const ex = buildGrammarExercises({ n: 4, grammar: ['gram-a-not-a'] }, items, sentences, {
      rng: () => 0.5,
    });
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ type: 'reorder', grammarId: 'gram-a-not-a', zh: '你忙不忙？' });
  });

  it('cloze options include the answer and no word already in the sentence', () => {
    const ex = buildGrammarExercises({ n: 3, grammar: ['gram-dou-all'] }, items, sentences, {
      rng: () => 0.2,
      perPoint: 1,
    });
    const c = ex.find((e) => e.type === 'cloze');
    expect(c).toBeDefined();
    if (c?.type === 'cloze') {
      expect(c.options).toContain(c.answer);
      expect(c.options.filter((o) => c.zh.includes(o))).toEqual([c.answer]);
    }
  });

  it('respects max', () => {
    const ex = buildGrammarExercises(
      { n: 3, grammar: ['gram-dou-all', 'gram-bu'] },
      items,
      sentences,
      { max: 1 },
    );
    expect(ex).toHaveLength(1);
  });
});
