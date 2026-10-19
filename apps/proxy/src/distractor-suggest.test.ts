import { describe, expect, it } from 'vitest';
import { pinyinToZhuyin, toPinyinNumeric, type DistractorSuggestions, type Word } from '@anan/core';
import { runSuggest, suggestRequest, suggestStatus } from './distractor-suggest.js';
import { QuotaExhaustedError } from './providers/types.js';

const w = (id: string, headword: string, pinyin: string, glossEn: string, over: Partial<Word> = {}): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'L1',
  source: 'tocfl',
  pinyin,
  pinyinNumeric: toPinyinNumeric(pinyin),
  zhuyin: pinyinToZhuyin(pinyin),
  glossEn,
  chars: [...headword],
  tags: [],
  ...over,
});
const 冰淇淋 = w('a', '冰淇淋', 'bīng qí lín', 'ice cream');
const 巧克力 = w('b', '巧克力', 'qiǎo kè lì', 'chocolate');
const 三明治 = w('c', '三明治', 'sān míng zhì', 'sandwich');
const 雪糕 = w('d', '雪糕', 'xuě gāo', 'ice cream (mainland)');
const 冰激凌 = w('e', '冰激凌', 'bīng jī líng', 'ice cream');
const 王小明 = w('f', '王小明', 'wáng xiǎo míng', 'Wang Xiaoming', { tags: ['name'] });
const ALL = [冰淇淋, 巧克力, 三明治, 雪糕, 冰激凌, 王小明];
const byHeadword = new Map(ALL.map((x) => [x.headword, x]));
const deps = (ask: (ws: Word[]) => Promise<{ results: Array<{ id: string; options: string[] }>; model: string }>) => {
  const log: string[] = [];
  return { ask, save: () => {}, log: (l: string) => log.push(l), now: () => new Date('2026-10-19T12:00:00Z'), lines: log };
};

describe('distractor suggestions (Phase 48 Part A.2)', () => {
  it('keeps only suggestions that pass the checks in code', async () => {
    const cache: DistractorSuggestions = { version: 1, words: {} };
    await runSuggest([冰淇淋], byHeadword, cache, deps(async () => ({
      model: 'm1',
      // 巧克力 / 三明治 fine; 冰激凌 also correct, 雪糕 another length, 王小明 a name, 冰淇淋 itself, 蛋糕捲 not in the lexicon, 冰红茶 simplified
      results: [{ id: 'a', options: ['巧克力', '三明治', '冰激凌', '雪糕', '王小明', '冰淇淋', '蛋糕捲', '冰红茶'] }],
    })));
    expect(cache.words.a).toEqual({ model: 'm1', headwords: ['巧克力', '三明治'] });
  });

  it('resumes: only words not asked yet, and stops cleanly on the free quota', async () => {
    const cache: DistractorSuggestions = { version: 1, words: { a: { model: 'm1', headwords: [] } } };
    const asked: string[][] = [];
    const d = deps(async (ws) => {
      asked.push(ws.map((x) => x.id));
      throw new QuotaExhaustedError(new Date('2026-10-20T07:00:00Z'), []);
    });
    const r = await runSuggest([冰淇淋, 巧克力, 三明治], byHeadword, cache, d, { batch: 50 });
    expect(asked).toEqual([['b', 'c']]);
    expect(r.stopped).toBe('quota');
    expect(suggestStatus([冰淇淋, 巧克力, 三明治], cache)).toMatch(/1 asked .* 2 left/);
  });

  it('one request carries the word, its meaning and part of speech', () => {
    const req = suggestRequest([冰淇淋]);
    expect(req.userMessage).toContain('"zh":"冰淇淋"');
    expect(req.userMessage).toContain('ice cream');
    expect(req.parse({ results: [{ id: 'a', options: ['巧克力'] }] }).results[0]!.options).toEqual(['巧克力']);
  });
});
