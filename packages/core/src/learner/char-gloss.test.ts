import { describe, expect, it } from 'vitest';
import { charsInWord } from './leech.js';
import { CHAR_GLOSS_MAX, shortCharGloss } from './char-gloss.js';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';

/** Phase 44: short character meanings for the review card's character row. */

const word = (id: string, headword: string, pinyin: string, pinyinNumeric: string, glossEn: string): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin,
  pinyinNumeric,
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags: [],
});

describe('shortCharGloss', () => {
  it.each([
    // Unihan (real entries from data/build/char-glosses.v1.json)
    ['dry; warming principle of the sun, penetrating and fertilizing, heavenly generative principle (male); trigram ☰; hexagram ䷀', 'dry'],
    ['teacher, master, specialist; multitude, troops; hexagram ䷆', 'teacher, master, specialist'],
    ['coffee; a phonetic', 'coffee'],
    ['central; center, middle; in the midst of; hit (target); attain', 'central; center, middle'],
    ['rice-cakes, biscuits', 'rice-cakes, biscuits'],
    // lexicon glosses: first one or two senses
    ['old; always; very', 'old; always'],
    ['to eat; to consume', 'to eat; to consume'],
    ['', ''],
  ])('%s → %s', (full, short) => {
    expect(shortCharGloss(full)).toBe(short);
  });
  it('never longer than the limit, never a trigram or hexagram', () => {
    const long = 'a very long single sense that goes on and on without any commas at all';
    expect(shortCharGloss(long).length).toBeLessThanOrEqual(CHAR_GLOSS_MAX);
    expect(shortCharGloss('trigram ☰; hexagram ䷀')).toBe('');
  });
});

describe('charsInWord meanings (Phase 44)', () => {
  const lexicon = new Lexicon([
    word('w-bing3', '餅', 'bǐng', 'bing3', 'round flat cake'),
    word('w-gan1', '乾', 'gān', 'gan1', 'dry'),
    word('w-binggan', '餅乾', 'bǐng gān', 'bing3 gan1', 'biscuit; cracker; cookie'),
    word('w-lao3', '老', 'lǎo', 'lao3', 'old; always; very'),
    word('w-kafei', '咖啡', 'kā fēi', 'ka1 fei1', 'coffee'),
    word('w-shi1', '師', 'shī', 'shi1', 'teacher'),
    word('w-laoshi', '老師', 'lǎo shī', 'lao3 shi1', 'teacher'),
  ]);
  const unihan = new Map([
    ['咖', 'coffee'],
    ['乾', 'dry'],
  ]);

  it('餅乾: each character with its reading and its own short meaning', () => {
    const parts = charsInWord(lexicon.byId('w-binggan')!, lexicon, unihan);
    expect(parts.map((p) => [p.ch, p.pinyin, p.glossEn])).toEqual([
      ['餅', 'bǐng', 'round flat cake'],
      ['乾', 'gān', 'dry'],
    ]);
  });
  it('a lexicon gloss keeps only its first two senses', () => {
    expect(charsInWord(lexicon.byId('w-laoshi')!, lexicon).map((p) => p.glossEn)).toEqual(['old; always', 'teacher']);
  });
  it('a character with no entry of its own takes the Unihan gloss; one in neither has no meaning', () => {
    const parts = charsInWord(lexicon.byId('w-kafei')!, lexicon, unihan);
    expect(parts[0]).toMatchObject({ ch: '咖', glossEn: 'coffee' });
    expect(parts[1]!.ch).toBe('啡');
    expect(parts[1]).not.toHaveProperty('glossEn');
  });
});
