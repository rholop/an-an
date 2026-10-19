import { describe, expect, it } from 'vitest';
import { pinyinToZhuyin, toPinyinNumeric } from '../pinyin.js';
import type { Level, Word } from '../types.js';
import { alsoCorrect, axesBetween, charSimilarity, ConfusableIndex, meaningCategories, oddOneOut, oddOneOutReason } from './index.js';

// Phase 48: the owner's two screenshots ("usually, normally" → 平常 / 廚師 / 醫師 / 老師 and
// "ice cream" → 冰淇淋 / 星期五 / 星期四 / 星期日) and fair sets, with the words' real lexicon
// part of speech, gloss and level.
let n = 0;
function w(headword: string, pinyin: string, glossEn: string, pos: string[], level: Level | null, over: Partial<Word> = {}): Word {
  n += 1;
  return {
    id: `fair-${n}-${headword}`,
    headword,
    variants: [],
    pos,
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

const 平常 = w('平常', 'píng cháng', 'ordinary; common; usually; ordinarily', ['Vs'], 'L4');
const 常常 = w('常常', 'cháng cháng', 'often', ['Adv'], 'N2');
const 非常 = w('非常', 'fēi cháng', 'very; really; extremely; highly', ['Adv'], 'N2');
const 平安 = w('平安', 'píng ān', 'safe and sound', ['Vs'], 'L3');
const 通常 = w('通常', 'tōng cháng', 'usually; normally', ['Adv'], 'L4');
const 總是 = w('總是', 'zǒng shì', 'always', ['Adv'], 'L1');
const 廚師 = w('廚師', 'chú shī', 'cook; chef', ['N'], 'L3');
const 醫師 = w('醫師', 'yī shī', 'doctor', ['N'], 'N2');
const 老師 = w('老師', 'lǎo shī', 'teacher', ['N'], 'N1');
const 律師 = w('律師', 'lǜ shī', 'lawyer', ['N'], 'L2');
const 冰淇淋 = w('冰淇淋', 'bīng qí lín', 'ice cream', ['N'], 'L1');
const 巧克力 = w('巧克力', 'qiǎo kè lì', 'chocolate', ['N'], 'N2');
const 三明治 = w('三明治', 'sān míng zhì', 'sandwich', ['N'], 'L1');
const 下午茶 = w('下午茶', 'xià wǔ chá', 'afternoon tea', ['N'], 'L2');
const 冰紅茶 = w('冰紅茶', 'bīng hóng chá', 'iced black tea', ['N'], 'L1');
const 星期四 = w('星期四', 'xīng qí sì', 'Thursday', ['N'], 'N1', { source: 'textbook' });
const 星期五 = w('星期五', 'xīng qí wǔ', 'Friday', ['N'], 'N1', { source: 'textbook' });
const 星期日 = w('星期日', 'xīng qí rì', 'Sunday', ['N'], 'N1', { source: 'textbook' });
const 計程車 = w('計程車', 'jì chéng chē', 'taxi', ['N'], 'N2');
const 出租車 = w('出租車', 'chū zū chē', 'taxi (mainland)', ['N'], null, { source: 'supplement' });
const 便利商店 = w('便利商店', 'biàn lì shāng diàn', 'convenience store', ['N'], 'N2');
const 平行 = w('平行', 'píng xíng', 'parallel', ['Vs'], 'L5');

const ALL = [平常, 常常, 非常, 平安, 通常, 總是, 廚師, 醫師, 老師, 律師, 冰淇淋, 巧克力, 三明治, 下午茶, 冰紅茶, 星期四, 星期五, 星期日, 計程車, 出租車, 便利商店, 平行];
const index = new ConfusableIndex(ALL);
// a beginner who just learned Lesson 4's jobs and the days of the week (what filled the old sets)
const KNOWN = new Set([廚師, 醫師, 老師, 星期四, 星期五, 星期日, 常常, 巧克力].map((x) => x.id));
const SEEDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const heads = (ws: readonly Word[]) => ws.map((x) => x.headword);

describe('oddOneOut (Phase 48 Part B.2)', () => {
  it.each([
    ['平常', [平常, 廚師, 醫師, 老師]],
    ['冰淇淋', [冰淇淋, 星期五, 星期四, 星期日]],
  ] as const)('the owner’s screenshot set for %s is an odd-one-out', (_, set) => {
    expect(oddOneOut(set[0], set)).toBe(true);
    expect(oddOneOut(set[0].headword, heads(set))).toBe(true); // the characters alone give it away
  });

  it.each([
    ['平常', [平常, 常常, 平安, 非常]],
    ['冰淇淋', [冰淇淋, 冰紅茶, 巧克力, 三明治]],
    ['老師', [老師, 醫師, 廚師, 律師]], // all …師, the answer too
    ['星期五', [星期五, 星期四, 星期日]], // all 星期…, the answer too
  ] as const)('a fair set for %s is not', (_, set) => {
    expect(oddOneOutReason(set[0], set)).toBeUndefined();
  });

  it('the wrong options all one meaning category the answer lacks', () => {
    expect(oddOneOutReason(三明治, [三明治, 常常, 總是])).toMatch(/frequency/);
    expect(oddOneOutReason(冰淇淋, [冰淇淋, 律師, 醫師])).toMatch(/師/);
    expect(oddOneOut(三明治, [三明治, 律師, 星期五])).toBe(false);
  });

  it('with one wrong option there is nothing to share', () => {
    expect(oddOneOut('平常', ['平常', '廚師'])).toBe(false);
  });
});

describe('every option close to the answer (Phase 48 Part B.1)', () => {
  it('meaning categories: frequency for 平常, food for 冰淇淋, jobs, days', () => {
    expect([...meaningCategories(平常)]).toContain('frequency');
    expect([...meaningCategories(冰淇淋)]).toContain('food');
    expect([...meaningCategories(冰紅茶)]).toContain('food');
    expect([...meaningCategories(廚師)]).toContain('occupation');
    expect([...meaningCategories(星期五)]).toContain('weekday');
  });

  it.each(SEEDS)('平常 never gets three …師 words, and every option shares an axis with it (seed %s)', (seed) => {
    const picks = index.pick(平常, { seed, preferred: KNOWN, levelCap: 'N2' });
    expect(picks.filter((p) => p.headword.endsWith('師')).length).toBeLessThan(2);
    for (const p of picks) expect(axesBetween(平常, p, charSimilarity).size).toBeGreaterThan(0);
    expect(oddOneOut(平常, picks)).toBe(false);
    expect(picks.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SEEDS)('冰淇淋 never gets three 星期… words (seed %s)', (seed) => {
    const picks = index.pick(冰淇淋, { seed, preferred: KNOWN, levelCap: 'N2' });
    expect(picks.filter((p) => p.headword.startsWith('星期')).length).toBeLessThan(2);
    expect(oddOneOut(冰淇淋, picks)).toBe(false);
    for (const p of picks) expect(axesBetween(冰淇淋, p, charSimilarity).size).toBeGreaterThan(0);
  });

  it('never a word that is also right: a synonym (通常) or the mainland form (出租車)', () => {
    for (const seed of SEEDS) expect(heads(index.pick(平常, { seed }))).not.toContain('通常');
    expect(alsoCorrect(計程車, 出租車)).toBe(true);
    expect(heads(index.pick(計程車, { seed: 'a', preferred: new Set([出租車.id]) }))).not.toContain('出租車');
  });

  it('fewer options rather than filler: nothing close, nothing offered', () => {
    expect(index.pick(便利商店, { seed: 'a', preferred: new Set(ALL.map((x) => x.id)) })).toEqual([]);
  });

  it('mixes the axes: a look-alike, a sound-alike and a meaning neighbour when there are some', () => {
    const picks = index.pickDetailed(平常, { seed: 'a', preferred: KNOWN });
    const axes = new Set(picks.flatMap((p) => [...p.axes]));
    expect(axes.has('char')).toBe(true);
    expect(axes.has('meaning')).toBe(true);
  });

  it('an unknown option at most one level above the learner (the word’s own level is fine)', () => {
    // 平行 (L5) shares 平 with 平常 (L4) but is above both
    for (const seed of SEEDS) expect(heads(index.pick(平常, { seed, levelCap: 'N2' }))).not.toContain('平行');
    expect(heads(index.pick(平常, { seed: 'a', levelCap: 'L4', n: 8 }))).toContain('平安');
  });

  it('harder as the card gets stronger: shared character and same category first', () => {
    const hard = index.pickDetailed(平常, { seed: 'a', hard: true, preferred: KNOWN });
    expect(hard[0]!.word.headword).toBe('常常');
  });

  it('Cloze with a sentence never offers a meaning neighbour (it could fit the sentence too)', () => {
    for (const seed of SEEDS) {
      const picks = index.pickDetailed(冰淇淋, { seed, mode: 'cloze', preferred: KNOWN });
      for (const p of picks) expect(p.axes.has('meaning')).toBe(false);
      expect(heads(picks.map((p) => p.word))).not.toContain('巧克力');
    }
  });
});
