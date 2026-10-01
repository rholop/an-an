import { describe, expect, it } from 'vitest';
import { collapseRedundantSlashParen, normalizeRow, splitAlternates, splitOptionalChar, splitPos } from './normalize.js';

describe('splitPos', () => {
  it('splits "/"-joined POS tags', () => {
    expect(splitPos('N / Vst')).toEqual(['N', 'Vst']);
    expect(splitPos('V-sep / N')).toEqual(['V-sep', 'N']);
    expect(splitPos('V/N')).toEqual(['V', 'N']);
  });
  it('leaves a single POS tag alone', () => {
    expect(splitPos('N')).toEqual(['N']);
  });
});

describe('splitAlternates: real rows from data/raw/tocfl-words.xlsx', () => {
  it('你/妳 (single shared reading) merges as variants', () => {
    const notes: any[] = [];
    expect(splitAlternates('你/妳', 'nǐ', notes)).toEqual([{ headword: '你', variants: ['妳'], pinyin: 'nǐ' }]);
    expect(notes[0].kind).toBe('variant-merged');
  });

  it('台灣/臺灣 merges as variants', () => {
    const notes: any[] = [];
    expect(splitAlternates('台灣/臺灣', 'táiwān', notes)).toEqual([
      { headword: '台灣', variants: ['臺灣'], pinyin: 'táiwān' },
    ]);
  });

  it('這裡/這裏/這兒 (3 spellings, 1 reading) merges as variants', () => {
    const notes: any[] = [];
    const result = splitAlternates('這裡/這裏/這兒', 'zhèlǐ', notes);
    expect(result).toEqual([{ headword: '這裡', variants: ['這裏', '這兒'], pinyin: 'zhèlǐ' }]);
  });

  it('爸爸/爸 (matching pinyin count) splits into two distinct words', () => {
    const notes: any[] = [];
    const result = splitAlternates('爸爸/爸', 'bàba/bà', notes);
    expect(result).toEqual([
      { headword: '爸爸', variants: [], pinyin: 'bàba' },
      { headword: '爸', variants: [], pinyin: 'bà' },
    ]);
    expect(notes[0].kind).toBe('split-alternates');
  });

  it('姊姊/姐姐/姊/姐 (4 headwords, 2 pinyins — count mismatch) is flagged, not guessed', () => {
    const notes: any[] = [];
    const result = splitAlternates('姊姊/姐姐/姊/姐', 'jiějie/jiě', notes);
    expect(result).toEqual([{ headword: '姊姊', variants: [], pinyin: 'jiějie' }]);
    expect(notes[0].kind).toBe('unparseable-alternates');
  });

  it('single headword, no slash: passes through unchanged', () => {
    const notes: any[] = [];
    expect(splitAlternates('貓', 'māo', notes)).toEqual([{ headword: '貓', variants: [], pinyin: 'māo' }]);
    expect(notes).toEqual([]);
  });
});

describe('collapseRedundantSlashParen: rows combining "/" and "()" for the same optional char', () => {
  it('盤/盤(子) -> 盤(子)', () => {
    expect(collapseRedundantSlashParen('盤/盤(子)')).toBe('盤(子)');
  });
  it('刷(子) / 刷 -> 刷(子) (order reversed, with stray spaces)', () => {
    expect(collapseRedundantSlashParen('刷(子) / 刷')).toBe('刷(子)');
  });
  it('leaves unrelated slash-alternates alone', () => {
    expect(collapseRedundantSlashParen('你/妳')).toBe('你/妳');
  });
});

describe('splitOptionalChar: real rows', () => {
  it('小孩(子) / xiǎohái(zi) — optional 子 mirrored in both cells', () => {
    const result = splitOptionalChar('小孩(子)', 'xiǎohái(zi)');
    expect(result).toEqual({ full: '小孩子', fullPinyin: 'xiǎoháizi', short: '小孩', shortPinyin: 'xiǎohái' });
  });

  it('車(子) / chē(zi)', () => {
    const result = splitOptionalChar('車(子)', 'chē(zi)');
    expect(result).toEqual({ full: '車子', fullPinyin: 'chēzi', short: '車', shortPinyin: 'chē' });
  });

  it('上(面) / shàng(miàn)', () => {
    const result = splitOptionalChar('上(面)', 'shàng(miàn)');
    expect(result).toEqual({ full: '上面', fullPinyin: 'shàngmiàn', short: '上', shortPinyin: 'shàng' });
  });

  it('returns undefined when the headword has no CJK parens at all', () => {
    expect(splitOptionalChar('貓', 'māo')).toBeUndefined();
  });

  it('returns undefined (not a guess) when the pinyin cell does not mirror the paren', () => {
    // 名字(˙ㄗ) has already had its bopomofo annotation stripped before this
    // function runs (see normalizeRow), so this exercises the defensive path
    // if that ever changes.
    expect(splitOptionalChar('名字(˙ㄗ)', 'míngzi')).toBeUndefined();
  });
});

describe('normalizeRow: end-to-end on real rows', () => {
  it('名字(˙ㄗ) / míngzi -> bopomofo annotation stripped, no split', () => {
    const notes: any[] = [];
    const senses = normalizeRow('名字(˙ㄗ)', 'míngzi', 'N', notes);
    expect(senses).toEqual([{ headword: '名字', variants: [], pinyin: 'míngzi', pos: ['N'] }]);
    expect(notes.some((n) => n.kind === 'bopomofo-annotation-stripped')).toBe(true);
  });

  it('小孩(子) / xiǎohái(zi) / N -> one word with a variant, not split into two senses', () => {
    const notes: any[] = [];
    const senses = normalizeRow('小孩(子)', 'xiǎohái(zi)', 'N', notes);
    expect(senses).toEqual([{ headword: '小孩子', variants: ['小孩'], pinyin: 'xiǎoháizi', pos: ['N'] }]);
  });

  it('叫 / jiào / "Vst / V" -> two senses, same headword+pinyin, different pos', () => {
    const notes: any[] = [];
    const senses = normalizeRow('叫', 'jiào', 'Vst / V', notes);
    expect(senses).toEqual([
      { headword: '叫', variants: [], pinyin: 'jiào', pos: ['Vst'] },
      { headword: '叫', variants: [], pinyin: 'jiào', pos: ['V'] },
    ]);
    expect(notes.some((n) => n.kind === 'multi-pos-split')).toBe(true);
  });

  it('爸爸/爸 / bàba/bà / N -> two distinct-word senses', () => {
    const notes: any[] = [];
    const senses = normalizeRow('爸爸/爸', 'bàba/bà', 'N', notes);
    expect(senses).toEqual([
      { headword: '爸爸', variants: [], pinyin: 'bàba', pos: ['N'] },
      { headword: '爸', variants: [], pinyin: 'bà', pos: ['N'] },
    ]);
  });

  it('fixes the breve/caron tone-3 mix while normalizing (小姐 xiăojiě -> xiǎojiě)', () => {
    const notes: any[] = [];
    const senses = normalizeRow('小姐', 'xiăojiě', 'N', notes);
    expect(senses[0]!.pinyin).toBe('xiǎojiě');
  });
});
