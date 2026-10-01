import { describe, expect, it } from 'vitest';
import type { Word } from '../types.js';
import { gradeClozeAnswer } from './grading.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword' | 'pinyin' | 'zhuyin'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyinNumeric: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

// Real CLAUDE.md-named heteronym/variant fixtures.
const HAI = word({ id: 'hai', headword: '還', pinyin: 'hái', zhuyin: 'ㄏㄞˊ', glossEn: 'still' });
const HUAN = word({ id: 'huan', headword: '還', pinyin: 'huán', zhuyin: 'ㄏㄨㄢˊ', glossEn: 'return' });
const CHANG = word({ id: 'chang', headword: '長', pinyin: 'cháng', zhuyin: 'ㄔㄤˊ', glossEn: 'long' });
const ZHANG = word({ id: 'zhang', headword: '長', pinyin: 'zhǎng', zhuyin: 'ㄓㄤˇ', glossEn: 'grow' });
const LE_PARTICLE = word({ id: 'le', headword: '了', pinyin: 'le', zhuyin: '˙ㄌㄜ', glossEn: 'completed action marker' });
const LIAO = word({ id: 'liao', headword: '了', pinyin: 'liǎo', zhuyin: 'ㄌㄧㄠˇ', glossEn: 'to finish' });
const XIEXIE = word({ id: 'xiexie', headword: '謝謝', pinyin: 'xiè xie', zhuyin: 'ㄒㄧㄝˋ ˙ㄒㄧㄝ', glossEn: 'to thank' });
const TAI = word({ id: 'tai', headword: '台', variants: ['臺'], pinyin: 'tái', zhuyin: 'ㄊㄞˊ', glossEn: 'platform' });

describe('gradeClozeAnswer: hanzi mode', () => {
  it('accepts the exact headword', () => {
    expect(gradeClozeAnswer('還', HAI, 'hanzi')).toBe('correct');
  });

  it('accepts a listed variant spelling', () => {
    expect(gradeClozeAnswer('臺', TAI, 'hanzi')).toBe('correct');
  });

  it('accepts either spelling when the canonical headword IS the variant form', () => {
    expect(gradeClozeAnswer('台', TAI, 'hanzi')).toBe('correct');
  });

  it('rejects the wrong character', () => {
    expect(gradeClozeAnswer('回', HUAN, 'hanzi')).toBe('wrong');
  });

  it('ignores surrounding punctuation/whitespace', () => {
    expect(gradeClozeAnswer(' 還 ', HAI, 'hanzi')).toBe('correct');
  });

  it('rejects empty input', () => {
    expect(gradeClozeAnswer('', HAI, 'hanzi')).toBe('wrong');
  });
});

describe('gradeClozeAnswer: pinyin mode — heteronyms graded by sense, not headword', () => {
  it('還 as hái (still): accepts hai2/hái, rejects huán', () => {
    expect(gradeClozeAnswer('hai2', HAI, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('hái', HAI, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('huan2', HAI, 'pinyin')).toBe('wrong');
  });

  it('還 as huán (return): accepts huan2/huán, rejects hái', () => {
    expect(gradeClozeAnswer('huan2', HUAN, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('huán', HUAN, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('hai2', HUAN, 'pinyin')).toBe('wrong');
  });

  it('長 as cháng (long) vs zhǎng (grow) grade independently', () => {
    expect(gradeClozeAnswer('chang2', CHANG, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('zhang3', CHANG, 'pinyin')).toBe('wrong');
    expect(gradeClozeAnswer('zhang3', ZHANG, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('chang2', ZHANG, 'pinyin')).toBe('wrong');
  });
});

describe('gradeClozeAnswer: pinyin mode — tone handling', () => {
  it('right word, wrong tone gives partial credit', () => {
    expect(gradeClozeAnswer('hai4', HAI, 'pinyin')).toBe('correct_wrong_tone');
  });

  it('typing a toned syllable with no tone at all gives partial credit', () => {
    expect(gradeClozeAnswer('hai', HAI, 'pinyin')).toBe('correct_wrong_tone');
  });

  it('an unmarked neutral-tone syllable (了, le) is a full match, not a hint', () => {
    expect(gradeClozeAnswer('le', LE_PARTICLE, 'pinyin')).toBe('correct');
  });

  it('explicit digit 5 for neutral tone is also a full match', () => {
    expect(gradeClozeAnswer('le5', LE_PARTICLE, 'pinyin')).toBe('correct');
  });

  it('了 as liǎo (to finish) requires its own tone, distinct from the neutral-tone particle sense', () => {
    expect(gradeClozeAnswer('liao3', LIAO, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('le', LIAO, 'pinyin')).toBe('wrong');
  });

  it('toneInsensitive accepts any tone once the base sounds match', () => {
    expect(gradeClozeAnswer('hai4', HAI, 'pinyin', { toneInsensitive: true })).toBe('correct');
    expect(gradeClozeAnswer('hai', HAI, 'pinyin', { toneInsensitive: true })).toBe('correct');
  });

  it('a multi-syllable word (謝謝) with a neutral second syllable grades each syllable on its own terms', () => {
    expect(gradeClozeAnswer('xie4 xie', XIEXIE, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('xie4 xie5', XIEXIE, 'pinyin')).toBe('correct');
    expect(gradeClozeAnswer('xie2 xie', XIEXIE, 'pinyin')).toBe('correct_wrong_tone');
  });

  it('wrong syllable count is wrong, not a partial match', () => {
    expect(gradeClozeAnswer('xie4', XIEXIE, 'pinyin')).toBe('wrong');
  });

  it('accepts the ASCII "v" shortcut for ü', () => {
    const NV = word({ id: 'nv', headword: '女', pinyin: 'nǚ', zhuyin: 'ㄋㄩˇ' });
    expect(gradeClozeAnswer('nv3', NV, 'pinyin')).toBe('correct');
  });
});

describe('gradeClozeAnswer: zhuyin mode', () => {
  it('還 as hái vs huán graded by sense, matching MOE zhuyin exactly', () => {
    expect(gradeClozeAnswer('ㄏㄞˊ', HAI, 'zhuyin')).toBe('correct');
    expect(gradeClozeAnswer('ㄏㄨㄢˊ', HAI, 'zhuyin')).toBe('wrong');
    expect(gradeClozeAnswer('ㄏㄨㄢˊ', HUAN, 'zhuyin')).toBe('correct');
  });

  it('unmarked zhuyin unambiguously means tone 1 (unlike pinyin)', () => {
    const YI = word({ id: 'yi1', headword: '一', pinyin: 'yī', zhuyin: 'ㄧ' });
    expect(gradeClozeAnswer('ㄧ', YI, 'zhuyin')).toBe('correct');
    expect(gradeClozeAnswer('ㄧˊ', YI, 'zhuyin')).toBe('correct_wrong_tone');
  });

  it('neutral-tone prefix must match exactly for a full credit', () => {
    expect(gradeClozeAnswer('˙ㄌㄜ', LE_PARTICLE, 'zhuyin')).toBe('correct');
    expect(gradeClozeAnswer('ㄌㄜ', LE_PARTICLE, 'zhuyin')).toBe('correct_wrong_tone'); // typed as if tone 1
  });

  it('a multi-syllable word grades each syllable, including its neutral-tone one', () => {
    expect(gradeClozeAnswer('ㄒㄧㄝˋ ˙ㄒㄧㄝ', XIEXIE, 'zhuyin')).toBe('correct');
    expect(gradeClozeAnswer('ㄒㄧㄝˋ ㄒㄧㄝ', XIEXIE, 'zhuyin')).toBe('correct_wrong_tone');
  });

  it('toneInsensitive ignores all tone marks', () => {
    expect(gradeClozeAnswer('ㄏㄨㄢ', HAI, 'zhuyin', { toneInsensitive: true })).toBe('wrong'); // wrong base, still wrong
    expect(gradeClozeAnswer('ㄏㄞ', HAI, 'zhuyin', { toneInsensitive: true })).toBe('correct');
  });
});
