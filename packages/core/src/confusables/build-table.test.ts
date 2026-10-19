import { describe, expect, it } from 'vitest';
import { pinyinToZhuyin, toPinyinNumeric } from '../pinyin.js';
import type { Level, Word } from '../types.js';
import { buildDistractorTable, checkSuggestion } from './build-table.js';
import { ConfusableIndex } from './index.js';

// Phase 48 Part A: the offline table and the checks on Gemini's suggestions.
let n = 0;
function w(headword: string, pinyin: string, glossEn: string, level: Level | null = 'L1', over: Partial<Word> = {}): Word {
  n += 1;
  return {
    id: `bt-${n}`,
    headword,
    variants: [],
    pos: ['N'],
    level,
    source: 'tocfl',
    pinyin,
    pinyinNumeric: toPinyinNumeric(pinyin),
    zhuyin: pinyinToZhuyin(pinyin),
    glossEn,
    chars: [...headword],
    tags: [],
    ...over,
  };
}
const 冰淇淋 = w('冰淇淋', 'bīng qí lín', 'ice cream');
const 冰紅茶 = w('冰紅茶', 'bīng hóng chá', 'iced black tea');
const 巧克力 = w('巧克力', 'qiǎo kè lì', 'chocolate', 'N2');
const 蛋撻 = w('蛋撻', 'dàn tà', 'egg tart');
const 冰激凌 = w('冰激凌', 'bīng jī líng', 'ice cream', null, { source: 'supplement' });
const 王大明 = w('王大明', 'wáng dà míng', 'Wang Daming', 'N1', { tags: ['name'] });
const 豆花 = w('豆花', 'dòu huā', 'tofu pudding', 'L5');
const ALL = [冰淇淋, 冰紅茶, 巧克力, 蛋撻, 冰激凌, 王大明, 豆花];
const byHeadword = new Map(ALL.map((x) => [x.headword, x]));

describe('distractor table (Phase 48 Part A)', () => {
  it('checks every suggestion in code: in the lexicon, same length, traditional, not also right, not a name', () => {
    expect(checkSuggestion(冰淇淋, '巧克力', byHeadword)).toBeUndefined();
    expect(checkSuggestion(冰淇淋, '蛋撻', byHeadword)).toBe('another length');
    expect(checkSuggestion(冰淇淋, '冰激凌', byHeadword)).toBe('also correct');
    expect(checkSuggestion(冰淇淋, '王大明', byHeadword)).toBe('a name');
    expect(checkSuggestion(冰淇淋, '冰红茶', byHeadword)).toBe('not in the lexicon');
    expect(checkSuggestion(冰淇淋, '他们好', new Map([...byHeadword, ['他们好', 冰紅茶]]))).toBe('simplified characters');
  });

  it('stores up to 8 candidates per studyable word with their axes; checked suggestions count as meaning', () => {
    const table = buildDistractorTable(ALL, { suggestions: { version: 1, words: { [冰淇淋.id]: { model: 'm', headwords: ['巧克力', '冰激凌', '王大明'] } } } });
    const entry = table.words[冰淇淋.id]!;
    expect(entry.length).toBeLessThanOrEqual(8);
    const axes = new Map(entry);
    expect(axes.get(冰紅茶.id)).toContain('char');
    expect(axes.get(巧克力.id)).toContain('suggest');
    expect(axes.has(冰激凌.id)).toBe(false);
    expect(axes.has(王大明.id)).toBe(false);
    expect(table.words[王大明.id]).toBeUndefined(); // names get no entry
    expect(table.words[豆花.id]).toBeUndefined(); // L5: not studyable for the table
  });

  it('a table suggestion makes an option the picker may use (as a meaning neighbour)', () => {
    const table = { version: 1 as const, words: { [冰淇淋.id]: [[巧克力.id, 'suggest']] as Array<[string, string]> } };
    const index = new ConfusableIndex(ALL.map((x) => (x === 巧克力 ? { ...x, glossEn: 'cocoa sweet' } : x)), { table });
    const picks = index.pickDetailed(冰淇淋, { seed: 'a' });
    const choc = picks.find((p) => p.word.id === 巧克力.id);
    expect(choc?.axes.has('meaning')).toBe(true);
  });
});
