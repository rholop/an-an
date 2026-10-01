import { describe, expect, it } from 'vitest';
import { coverage, levelOf } from './level.js';
import { Lexicon } from './lexicon.js';
import { segment } from './segment.js';
import type { Word } from './types.js';

function w(partial: Partial<Word> & Pick<Word, 'id' | 'headword' | 'pinyin'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: null,
    source: 'tocfl',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

describe('levelOf / coverage stubs', () => {
  const lexicon = new Lexicon([
    w({ id: 'a', headword: '你好', pinyin: 'nǐ hǎo', level: 'N1' }),
    w({ id: 'b', headword: '謝謝', pinyin: 'xiè xie', level: 'N1' }),
    w({ id: 'c', headword: '哲學', pinyin: 'zhé xué', level: 'L4' }),
  ]);

  it('levelOf returns the lexicon level for a word token', () => {
    const tokens = segment('你好', lexicon);
    expect(levelOf(tokens[0]!, lexicon)).toBe('N1');
  });

  it('levelOf returns null for punctuation/number/unknown tokens', () => {
    const tokens = segment('123', lexicon);
    expect(levelOf(tokens[0]!, lexicon)).toBeNull();
  });

  it('coverage counts tokens per level and known/unknown against the given set', () => {
    const tokens = segment('你好，哲學。', lexicon);
    const result = coverage(tokens, lexicon, new Set(['a']));
    expect(result.byLevel.N1).toBe(1);
    expect(result.byLevel.L4).toBe(1);
    expect(result.knownCount).toBe(1); // 你好 (id "a") is in knownSet
    expect(result.unknownCount).toBe(1); // 哲學 is not
  });
});
