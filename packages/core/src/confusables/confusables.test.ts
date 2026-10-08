import { describe, expect, it } from 'vitest';
import { pinyinToZhuyin, toPinyinNumeric } from '../pinyin.js';
import type { Word } from '../types.js';
import { alsoCorrect, charSimilarity, ConfusableIndex, confusionsFromEvidence } from './index.js';

let n = 0;
function w(headword: string, pinyin: string, glossEn: string, over: Partial<Word> = {}): Word {
  n += 1;
  return {
    id: `cf-${n}-${headword}`,
    headword,
    variants: [],
    pos: ['V'],
    level: 'L1',
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

// Real Taiwan Mandarin words and their classic confusions.
const 買 = w('買', 'mǎi', 'to buy');
const 賣 = w('賣', 'mài', 'to sell');
const 是 = w('是', 'shì', 'to be; yes');
const 事 = w('事', 'shì', 'matter; thing; affair');
const 市 = w('市', 'shì', 'city; market');
const 十 = w('十', 'shí', 'ten');
const 老師 = w('老師', 'lǎo shī', 'teacher');
const 老實 = w('老實', 'lǎo shí', 'honest');
const 教師 = w('教師', 'jiào shī', 'teacher (formal)');
const 老人 = w('老人', 'lǎo rén', 'old person');
const 爸爸 = w('爸爸', 'bà ba', 'dad; father');
const 父親 = w('父親', 'fù qīn', 'father');
const 還hai = w('還', 'hái', 'still; yet');
const 還huan = w('還', 'huán', 'to give back; to return');
const 己 = w('己', 'jǐ', 'oneself');
const 已 = w('已', 'yǐ', 'already');
const 人 = w('人', 'rén', 'person; people');
const 入 = w('入', 'rù', 'to enter');
const 未 = w('未', 'wèi', 'not yet');
const 末 = w('末', 'mò', 'end; tip');
const 喝 = w('喝', 'hē', 'to drink');
const 渴 = w('渴', 'kě', 'thirsty');
const 捷運 = w('捷運', 'jié yùn', 'MRT (Taipei metro)');
const 機車 = w('機車', 'jī chē', 'motor scooter');
const 公車 = w('公車', 'gōng chē', 'bus');
const 火車 = w('火車', 'huǒ chē', 'train');
const 電車 = w('電車', 'diàn chē', 'tram');
const 汽車 = w('汽車', 'qì chē', 'car; automobile');
const 車子 = w('車子', 'chē zi', 'car; vehicle');
const 吃 = w('吃', 'chī', 'to eat');
const 賈 = w('賈', 'jiǎ', 'merchant (surname)', { source: 'supplement', level: null });

const ALL = [
  買, 賣, 是, 事, 市, 十, 老師, 老實, 教師, 老人, 爸爸, 父親, 還hai, 還huan, 己, 已, 人, 入, 未, 末, 喝, 渴,
  捷運, 機車, 公車, 火車, 電車, 汽車, 車子, 吃, 賈,
];
const index = new ConfusableIndex(ALL);

describe('confusables (Phase 23 Part B)', () => {
  it('characters that look alike: shared radical and strokes, phonetic component, classic pairs', () => {
    expect(charSimilarity('買', '賣')).toBeGreaterThan(0);
    expect(charSimilarity('己', '已')).toBe(1);
    expect(charSimilarity('人', '入')).toBe(1);
    expect(charSimilarity('未', '末')).toBe(1);
    expect(charSimilarity('喝', '渴')).toBeGreaterThan(0);
    expect(charSimilarity('吃', '十')).toBe(0);
  });

  it('never a correct answer: other senses, variants and synonyms are left out', () => {
    expect(alsoCorrect(爸爸, 父親)).toBe(true);
    expect(alsoCorrect(老師, 教師)).toBe(true);
    expect(alsoCorrect(還hai, 還huan)).toBe(true);
    expect(alsoCorrect(汽車, 車子)).toBe(true);
    expect(alsoCorrect(買, 賣)).toBe(false);
    expect(alsoCorrect(老師, 老實)).toBe(false);
    expect(alsoCorrect(是, 事)).toBe(false);
  });

  it.each([
    [買, 賣],
    [老師, 老實],
    [己, 已],
    [人, 入],
    [未, 末],
    [喝, 渴],
  ])('%s: three same-length options, with its classic look-alike, none also right', (target, alike) => {
    const picks = index.pick(target, { seed: 's' });
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => [...p.headword].length === [...target.headword].length)).toBe(true);
    expect(picks.map((p) => p.headword)).toContain(alike.headword);
    expect(picks.some((p) => alsoCorrect(target, p))).toBe(false);
    expect(new Set(picks.map((p) => p.headword)).size).toBe(3);
  });

  it('教師 is never offered for 老師 (it would also be right)', () => {
    for (const seed of ['a', 'b', 'c', 'd'])
      expect(index.pick(老師, { seed }).map((p) => p.headword)).not.toContain('教師');
  });

  it('sound mode: homophones and tone variants (是/事/市, 是/十)', () => {
    const picks = index.pick(是, { mode: 'sound', seed: 's' }).map((p) => p.headword);
    expect(picks).toEqual(expect.arrayContaining(['事', '市', '十']));
  });

  it('the learner’s own mix-ups come first (when they are the same length)', () => {
    const two = index.pick(機車, { seed: 's', confusedWith: new Set([捷運.id, 吃.id]) });
    expect(two[0]!.headword).toBe('捷運');
    expect(two.map((p) => p.headword)).not.toContain('吃');
  });

  it('obscure dictionary extras are not offered unless the learner knows them', () => {
    expect(index.pick(買, { seed: 's' }).map((p) => p.headword)).not.toContain('賈');
    expect(index.pick(買, { seed: 's', preferred: new Set([賈.id]) }).map((p) => p.headword)).toContain('賈');
  });

  it('mix-ups are read from wrong picks, both ways', () => {
    const m = confusionsFromEvidence([
      { item: { kind: 'word', id: 'a' }, context: { pickedId: 'b' } },
      { item: { kind: 'word', id: 'c' } },
    ]);
    expect([...(m.get('a') ?? [])]).toEqual(['b']);
    expect([...(m.get('b') ?? [])]).toEqual(['a']);
  });
});
