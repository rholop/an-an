import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { computeCharStats, transparency } from './char-stats.js';
import { emptyCard } from './fsrs-instance.js';
import type { SkillCard } from './types.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: null,
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

function card(itemId: string, stability: number): SkillCard {
  const now = new Date('2026-01-01');
  return {
    item: { kind: 'word', id: itemId },
    skill: 'recognition',
    card: { ...emptyCard(now), stability },
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}

describe('computeCharStats', () => {
  const lexicon = new Lexicon([
    word({ id: 'w1', headword: '銀行' }), // 銀, 行
    word({ id: 'w2', headword: '行李' }), // 行, 李
    word({ id: 'w3', headword: '銀色' }), // 銀, 色
  ]);

  it('computes max/mean stability per character across every word containing it', () => {
    const cards = [card('w1', 10), card('w2', 20), card('w3', 4)];
    const stats = computeCharStats(cards, lexicon);
    // 行 appears in w1 (stability 10) and w2 (stability 20)
    expect(stats.get('行')).toEqual({ max: 20, mean: 15, sampleCount: 2 });
    // 銀 appears in w1 (10) and w3 (4)
    expect(stats.get('銀')).toEqual({ max: 10, mean: 7, sampleCount: 2 });
    // 李 appears only in w2 (20)
    expect(stats.get('李')).toEqual({ max: 20, mean: 20, sampleCount: 1 });
  });

  it('ignores cards for items not in the lexicon or not kind "word"', () => {
    const cards = [
      card('does-not-exist', 99),
      { ...card('w1', 10), item: { kind: 'grammar' as const, id: 'gram-x' } },
    ];
    const stats = computeCharStats(cards, lexicon);
    expect(stats.size).toBe(0);
  });
});

describe('transparency', () => {
  const lexicon = new Lexicon([word({ id: 'w1', headword: '銀行' })]);
  const cards = [card('w1', 10)];
  const stats = computeCharStats(cards, lexicon);

  it('is 1 when every character is already known', () => {
    expect(transparency({ chars: ['銀'] }, stats)).toBe(1);
  });

  it('is a fraction when only some characters are known', () => {
    expect(transparency({ chars: ['銀', '色'] }, stats)).toBe(0.5);
  });

  it('is 0 when no characters are known', () => {
    expect(transparency({ chars: ['貓'] }, stats)).toBe(0);
  });

  it('is 1 for a word with no characters (degenerate case, never crashes)', () => {
    expect(transparency({ chars: [] }, stats)).toBe(1);
  });
});
