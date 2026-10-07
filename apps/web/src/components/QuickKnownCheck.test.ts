import { describe, expect, it } from 'vitest';
import { Lexicon, type Lesson, type Word } from '@anan/core';
import { buildQuickCheck } from './QuickKnownCheck.js';

// Phase 19 Part A: the lesson's "I already know this lesson" check showed each word's
// recognition card immediately followed by its production card, in book order.
const w = (id: string, headword: string, glossEn: string): Word => ({
  id,
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

const WORDS = [
  w('w1', '捷運', 'MRT'),
  w('w2', '機車', 'scooter'),
  w('w3', '便利商店', 'convenience store'),
  w('w4', '垃圾車', 'garbage truck'),
  w('w5', '老師', 'teacher'),
  w('w6', '學生', 'student'),
  w('w7', '咖啡', 'coffee'),
  w('w8', '茶', 'tea'),
  w('w9', '朋友', 'friend'),
  w('w10', '臺灣', 'Taiwan'),
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
});
