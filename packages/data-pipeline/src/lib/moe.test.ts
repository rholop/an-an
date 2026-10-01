import { describe, expect, it } from 'vitest';
import { MoeDictionary, resolveMoeReading, type MoeEntry } from './moe.js';

function entry(title: string, heteronyms: MoeEntry['heteronyms'], english?: string): MoeEntry {
  return { title, heteronyms, English: english };
}

describe('resolveMoeReading: direct phrase match', () => {
  const moe = MoeDictionary.fromEntries([
    entry('捷運', [{ pinyin: 'jié yùn', bopomofo: 'ㄐㄧㄝˊ ㄩㄣˋ' }], 'MRT'),
    entry('長', [
      { pinyin: 'cháng', bopomofo: 'ㄔㄤˊ' },
      { pinyin: 'zhǎng', bopomofo: 'ㄓㄤˇ' },
    ]),
  ]);

  it('uses MOE pinyin/zhuyin verbatim when the whole word is a title', () => {
    const r = resolveMoeReading(moe, '捷運', 'jiéyùn');
    expect(r).toMatchObject({ pinyin: 'jié yùn', zhuyin: 'ㄐㄧㄝˊ ㄩㄣˋ', source: 'moe-phrase' });
    expect(r.mismatch).toBeUndefined();
  });

  it('records a mismatch when the TOCFL pinyin disagrees, but still prefers MOE', () => {
    const r = resolveMoeReading(moe, '長', 'cháng');
    expect(r.pinyin).toBe('cháng');
    // exact match here, no mismatch
    expect(r.mismatch).toBeUndefined();
  });

  it('picks the ambiguous title heteronym matching the TOCFL pinyin', () => {
    const r = resolveMoeReading(moe, '長', 'zhǎng');
    expect(r.pinyin).toBe('zhǎng');
  });
});

describe('resolveMoeReading: variant-character redirect (台 -> 臺, etc.)', () => {
  const moe = MoeDictionary.fromEntries([
    entry('台', [
      { definitions: [{ def: '「臺」的異體字。' }] },
      { pinyin: 'tāi', bopomofo: 'ㄊㄞ', definitions: [{ def: '地名用字。' }] },
      { pinyin: 'yí', bopomofo: 'ㄧˊ', definitions: [{ def: '我。' }] },
    ]),
    entry('臺', [{ pinyin: 'tái', bopomofo: 'ㄊㄞˊ' }]),
    entry('灣', [{ pinyin: 'wān', bopomofo: 'ㄨㄢ' }]),
  ]);

  it('composes 台灣 as tái wān, not 台\'s own rare readings (tāi/yí)', () => {
    const r = resolveMoeReading(moe, '台灣', 'táiwān');
    expect(r.pinyin).toBe('tái wān');
    expect(r.zhuyin).toBe('ㄊㄞˊ ㄨㄢ');
    expect(r.source).toBe('moe-composed');
    expect(r.mismatch).toBeUndefined();
  });
});

describe('resolveMoeReading: per-character composition with heteronym disambiguation', () => {
  const moe = MoeDictionary.fromEntries([
    entry('從', [
      { pinyin: 'zōng', bopomofo: 'ㄗㄨㄥ' },
      { pinyin: 'zòng', bopomofo: 'ㄗㄨㄥˋ' },
      { pinyin: 'cōng', bopomofo: 'ㄘㄨㄥ' },
      { pinyin: 'cóng', bopomofo: 'ㄘㄨㄥˊ' },
    ]),
    entry('不', [{ pinyin: 'bù', bopomofo: 'ㄅㄨˋ' }]),
  ]);

  it('uses the TOCFL pinyin as a substring hint to pick the right heteronym, tone included', () => {
    const r = resolveMoeReading(moe, '從不', 'cóngbù');
    expect(r.pinyin).toBe('cóng bù'); // not zōng/zòng/cōng
  });
});

describe('resolveMoeReading: erhua suffix (兒) never gets MOE\'s rarer literal reading', () => {
  const moe = MoeDictionary.fromEntries([
    entry('畫', [{ pinyin: 'huà', bopomofo: 'ㄏㄨㄚˋ' }]),
    // MOE genuinely lists "ní" before "ér" for 兒 — this is the real data shape.
    entry('兒', [
      { pinyin: 'ní', bopomofo: 'ㄋㄧˊ' },
      { pinyin: 'ér', bopomofo: 'ㄦˊ' },
    ]),
  ]);

  it('畫兒 (huàr) resolves 兒 to ér, not MOE\'s list-order-first ní', () => {
    const r = resolveMoeReading(moe, '畫兒', 'huàr');
    expect(r.pinyin).toBe('huà ér');
  });
});

describe('resolveMoeReading: character with no MOE entry at all', () => {
  const moe = MoeDictionary.fromEntries([entry('你', [{ pinyin: 'nǐ', bopomofo: 'ㄋㄧˇ' }])]);

  it('flags tocfl-unverified rather than inventing a reading', () => {
    const r = resolveMoeReading(moe, '你囍', 'nǐxǐ'); // 囍 (double-happiness) not in this tiny fixture
    expect(r.source).toBe('tocfl-unverified');
  });
});

describe('MoeDictionary.gloss', () => {
  const moe = MoeDictionary.fromEntries([
    entry('貓', [{ pinyin: 'māo', bopomofo: 'ㄇㄠ' }], 'cat'),
    entry('囧', [{ pinyin: 'jiǒng' }]), // no English at all
  ]);

  it('returns the top-level English field when present', () => {
    expect(moe.gloss('貓')).toBe('cat');
  });

  it('returns undefined when there is no gloss', () => {
    expect(moe.gloss('囧')).toBeUndefined();
  });

  it('returns undefined for a title not in the dictionary', () => {
    expect(moe.gloss('不存在')).toBeUndefined();
  });
});
