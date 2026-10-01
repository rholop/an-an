import { describe, expect, it } from 'vitest';
import {
  normalizePinyinText,
  parseSyllableTone,
  pinyinSyllableToZhuyin,
  pinyinToZhuyin,
  toPinyinNumeric,
} from './pinyin.js';

describe('normalizePinyinText', () => {
  it('fixes the TOCFL spreadsheet breve/caron tone-3 inconsistency', () => {
    // Observed in data/raw/tocfl-words.xlsx: 'wŏ' uses breve (U+014F), not
    // the correct tone-3 caron (U+01D2).
    expect(normalizePinyinText('wŏ')).toBe('wǒ');
    expect(normalizePinyinText('nĭ')).toBe('nǐ');
    expect(normalizePinyinText('xiăojiě')).toBe('xiǎojiě');
  });

  it('normalizes the IPA/Cyrillic script-a glyph to plain "a"', () => {
    expect(normalizePinyinText('ɑ̄i')).not.toContain('ɑ');
  });

  it('strips zero-width spaces and collapses whitespace', () => {
    expect(normalizePinyinText('wŏmen​ ')).toBe('wǒmen');
  });
});

describe('parseSyllableTone', () => {
  const cases: [string, string, number][] = [
    ['mā', 'ma', 1],
    ['má', 'ma', 2],
    ['mǎ', 'ma', 3],
    ['mà', 'ma', 4],
    ['ma', 'ma', 5],
    ['lǜ', 'lü', 4],
    ['nǚ', 'nü', 3],
  ];
  it.each(cases)('%s -> base %s tone %i', (input, base, tone) => {
    expect(parseSyllableTone(input)).toEqual({ base, tone });
  });
});

describe('toPinyinNumeric', () => {
  it('matches the CLAUDE.md example (咖啡, from MOE\'s space-separated "kā fēi")', () => {
    expect(toPinyinNumeric('kā fēi')).toBe('ka1 fei1');
  });
  it('splits on existing spaces and tones each syllable', () => {
    expect(toPinyinNumeric('wǒ men')).toBe('wo3 men5');
  });
  it('does not guess syllable boundaries when the source gives none', () => {
    // MOE always separates syllables with spaces; the TOCFL list sometimes
    // doesn't. The pipeline handles that by composing per-character MOE
    // lookups rather than asking this function to split "wǒmen" itself.
    expect(toPinyinNumeric('kāfēi')).toBe('kafei1');
  });
});

// Ground truth for the hand-rolled pinyin -> zhuyin converter. Covers every
// initial, the apical-vowel (zhi/chi/shi/ri/zi/ci/si) special case, the
// y/w/ü zero-initial spellings, the j/q/x "u means ü" spelling quirk, and
// all four tones plus neutral.
describe('pinyinSyllableToZhuyin', () => {
  const cases: [string, string][] = [
    ['mā', 'ㄇㄚ'], ['má', 'ㄇㄚˊ'], ['mǎ', 'ㄇㄚˇ'], ['mà', 'ㄇㄚˋ'], ['ma', '˙ㄇㄚ'],
    ['bā', 'ㄅㄚ'], ['pò', 'ㄆㄛˋ'], ['dé', 'ㄉㄜˊ'], ['tǔ', 'ㄊㄨˇ'],
    ['nǐ', 'ㄋㄧˇ'], ['lǜ', 'ㄌㄩˋ'], ['gāo', 'ㄍㄠ'], ['kě', 'ㄎㄜˇ'], ['hǎo', 'ㄏㄠˇ'],
    ['zhǎng', 'ㄓㄤˇ'], ['cháng', 'ㄔㄤˊ'], ['shì', 'ㄕˋ'], ['rì', 'ㄖˋ'],
    ['zì', 'ㄗˋ'], ['cì', 'ㄘˋ'], ['sì', 'ㄙˋ'],
    ['zhī', 'ㄓ'], ['chī', 'ㄔ'], ['shī', 'ㄕ'],
    ['jié', 'ㄐㄧㄝˊ'], ['qù', 'ㄑㄩˋ'], ['xué', 'ㄒㄩㄝˊ'],
    ['jūn', 'ㄐㄩㄣ'], ['quān', 'ㄑㄩㄢ'], ['xùn', 'ㄒㄩㄣˋ'],
    ['yī', 'ㄧ'], ['yá', 'ㄧㄚˊ'], ['yè', 'ㄧㄝˋ'], ['yāo', 'ㄧㄠ'], ['yǒu', 'ㄧㄡˇ'],
    ['yán', 'ㄧㄢˊ'], ['yīn', 'ㄧㄣ'], ['yáng', 'ㄧㄤˊ'], ['yīng', 'ㄧㄥ'], ['yòng', 'ㄩㄥˋ'],
    ['wū', 'ㄨ'], ['wá', 'ㄨㄚˊ'], ['wǒ', 'ㄨㄛˇ'], ['wài', 'ㄨㄞˋ'], ['wèi', 'ㄨㄟˋ'],
    ['wǎn', 'ㄨㄢˇ'], ['wén', 'ㄨㄣˊ'], ['wáng', 'ㄨㄤˊ'], ['wēng', 'ㄨㄥ'],
    ['yū', 'ㄩ'], ['yuè', 'ㄩㄝˋ'], ['yuán', 'ㄩㄢˊ'], ['yùn', 'ㄩㄣˋ'],
    ['ài', 'ㄞˋ'], ['ēn', 'ㄣ'], ['áng', 'ㄤˊ'], ['ér', 'ㄦˊ'], ['ā', 'ㄚ'], ['è', 'ㄜˋ'],
    ['jiǎng', 'ㄐㄧㄤˇ'], ['xiōng', 'ㄒㄩㄥ'], ['zhuāng', 'ㄓㄨㄤ'],
  ];
  it.each(cases)('%s -> %s', (pinyin, zhuyin) => {
    expect(pinyinSyllableToZhuyin(pinyin)).toBe(zhuyin);
  });

  it('throws rather than silently emitting a wrong reading for garbage input', () => {
    expect(() => pinyinSyllableToZhuyin('xyz')).toThrow();
  });
});

describe('pinyinToZhuyin (multi-syllable, matches MOE formatting)', () => {
  it('長度 / cháng dù', () => {
    expect(pinyinToZhuyin('cháng dù')).toBe('ㄔㄤˊ ㄉㄨˋ');
  });
  it('我們 / wǒ men (neutral tone prefixed)', () => {
    expect(pinyinToZhuyin('wǒ men')).toBe('ㄨㄛˇ ˙ㄇㄣ');
  });
  it('捷運 / jié yùn', () => {
    expect(pinyinToZhuyin('jié yùn')).toBe('ㄐㄧㄝˊ ㄩㄣˋ');
  });
});
