import { describe, expect, it } from 'vitest';
import { checkTaiwanness, isSimplifiedOnly } from './taiwanness.js';
import { MAINLAND_TERMS } from './data/mainland-terms.generated.js';

describe('checkTaiwanness: mainland-term blocklist', () => {
  it('flags every entry in the blocklist', () => {
    for (const entry of MAINLAND_TERMS) {
      for (const spelling of entry.mainland) {
        const result = checkTaiwanness(`他坐${spelling}去上班。`);
        expect(result.mainlandTerms.some((h) => h.matched === spelling && h.taiwan === entry.taiwan)).toBe(
          true,
        );
      }
    }
  });

  it('does not flag clean Taiwan text containing the Taiwan equivalents', () => {
    const result = checkTaiwanness('他坐捷運去上班，用悠遊卡付錢。');
    expect(result.mainlandTerms).toEqual([]);
  });

  it('prefers the longest match (視頻通話 over 視頻)', () => {
    const result = checkTaiwanness('我們用視頻通話聊天。');
    expect(result.mainlandTerms).toHaveLength(1);
    expect(result.mainlandTerms[0]!.matched).toBe('視頻通話');
  });
});

describe('checkTaiwanness: simplified character detection', () => {
  it('flags any simplified character', () => {
    const result = checkTaiwanness('我在国家图书馆学习。');
    const flaggedChars = result.simplifiedChars.map((h) => h.char);
    expect(flaggedChars).toContain('国');
    expect(flaggedChars).toContain('图');
    expect(flaggedChars).toContain('学');
  });

  it('does not flag traditional characters, including ones that look similar to simplified forms', () => {
    const result = checkTaiwanness('國家圖書館的學生在看書。');
    expect(result.simplifiedChars).toEqual([]);
  });

  it('does not false-positive on characters that are valid in both scripts (台, 后, 云)', () => {
    // 台灣 / 皇后 / 人云亦云 all use traditional-valid characters that also
    // happen to double as simplified forms elsewhere — must not be flagged.
    expect(isSimplifiedOnly('台')).toBe(false);
    expect(isSimplifiedOnly('后')).toBe(false);
    expect(isSimplifiedOnly('云')).toBe(false);
    const result = checkTaiwanness('台灣、皇后、人云亦云');
    expect(result.simplifiedChars).toEqual([]);
  });

  it('isClean is true only when both checks pass', () => {
    expect(checkTaiwanness('這是乾淨的繁體中文。').isClean).toBe(true);
    expect(checkTaiwanness('这是简体字').isClean).toBe(false);
  });
});
