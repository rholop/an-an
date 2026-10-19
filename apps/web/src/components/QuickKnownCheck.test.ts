import { describe, expect, it } from 'vitest';
import { Lexicon, oddOneOut, pinyinToZhuyin, toPinyinNumeric, type Lesson, type Word } from '@anan/core';
import { buildQuickCheck } from './QuickKnownCheck.js';

// Phase 19 Part A: the lesson's "I already know this lesson" check showed each word's
// recognition card immediately followed by its production card, in book order.
const w = (id: string, headword: string, pinyin: string, glossEn: string): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin,
  pinyinNumeric: toPinyinNumeric(pinyin),
  zhuyin: pinyinToZhuyin(pinyin),
  glossEn,
  chars: [...headword],
  tags: [],
});

// Phase 48: words with close neighbours (a shared character), so every word has fair options
const WORDS = [
  w('w1', '老師', 'lǎo shī', 'teacher'),
  w('w2', '老人', 'lǎo rén', 'old person'),
  w('w3', '老家', 'lǎo jiā', 'hometown'),
  w('w4', '學生', 'xué shēng', 'student'),
  w('w5', '學校', 'xué xiào', 'school'),
  w('w6', '學期', 'xué qí', 'semester'),
  w('w7', '先生', 'xiān shēng', 'Mr.; husband'),
  w('w8', '生日', 'shēng rì', 'birthday'),
  w('w9', '日期', 'rì qí', 'date'),
  w('w10', '日本', 'rì běn', 'Japan'),
];

const lesson: Lesson = {
  id: 'laixue-1-L01',
  n: 1,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: WORDS.map((x) => x.id),
  supplementary: [],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
};

describe('buildQuickCheck (Phase 19)', () => {
  const lex = new Lexicon(WORDS);

  it('never puts two questions about the same word next to each other, and keeps them 5+ apart', () => {
    for (let run = 0; run < 50; run++) {
      const qs = buildQuickCheck(lesson, lex, [], [], `seed-${run}`);
      const last = new Map<string, number>();
      qs.forEach((q, i) => {
        const prev = last.get(q.item.id);
        if (prev !== undefined) expect(i - prev).toBeGreaterThan(5);
        last.set(q.item.id, i);
      });
    }
  });

  it('is not in book order', () => {
    const qs = buildQuickCheck(lesson, lex, [], [], 'seed-x');
    const firstSeen = [...new Set(qs.map((q) => q.item.id))];
    expect(firstSeen).not.toEqual(WORDS.map((x) => x.id));
  });

  it('still asks both directions for each word when the lesson is long enough', () => {
    const qs = buildQuickCheck(lesson, lex, [], [], 'seed-y');
    expect(qs).toHaveLength(WORDS.length * 2);
  });

  it('Phase 48: production options are close to the word and the answer is never the odd one out', () => {
    for (const q of buildQuickCheck(lesson, lex, [], [], 'seed-z')) {
      if (q.skill !== 'production') continue;
      expect(q.options.length).toBeGreaterThanOrEqual(3);
      expect(oddOneOut(q.answer, q.options)).toBe(false);
    }
  });
});
