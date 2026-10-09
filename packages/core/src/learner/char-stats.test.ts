import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { knownCharacters, transparency } from './char-stats.js';

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

describe('knownCharacters (Phase 29: the characters of Learned words only)', () => {
  const lexicon = new Lexicon([
    word({ id: 'w1', headword: '銀行' }),
    word({ id: 'w2', headword: '行李' }),
    word({ id: 'w3', headword: '銀色' }),
  ]);

  it('collects the characters of the Learned words', () => {
    expect([...knownCharacters(['w1', 'w2'], lexicon)].sort()).toEqual(['李', '行', '銀'].sort());
  });

  it('ignores ids not in the lexicon', () => {
    expect(knownCharacters(['does-not-exist'], lexicon).size).toBe(0);
  });
});

describe('transparency', () => {
  const known = new Set(['銀', '行']);

  it('is 1 when every character is already known', () => {
    expect(transparency({ chars: ['銀'] }, known)).toBe(1);
  });

  it('is a fraction when only some characters are known', () => {
    expect(transparency({ chars: ['銀', '色'] }, known)).toBe(0.5);
  });

  it('is 0 when no characters are known', () => {
    expect(transparency({ chars: ['貓'] }, known)).toBe(0);
  });

  it('is 1 for a word with no characters (degenerate case, never crashes)', () => {
    expect(transparency({ chars: [] }, known)).toBe(1);
  });
});
