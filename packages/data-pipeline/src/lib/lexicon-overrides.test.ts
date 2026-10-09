import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Word } from '@anan/core';
import { applyLexiconOverrides, loadLexiconOverrides } from './lexicon-overrides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const word = (over: Partial<Word> & { id: string; headword: string }): Word => ({
  variants: [], pos: [], level: null, source: 'textbook', pinyin: '', pinyinNumeric: '', zhuyin: '',
  glossEn: '', chars: [...over.headword], tags: [], ...over,
});

describe('Phase 25 lexicon overrides', () => {
  it('fixes the reading, headword and gloss and marks the reading as an override', () => {
    const words = [
      word({ id: 'a', headword: '噢', pinyin: 'yǔ', zhuyin: 'ㄩˇ', tags: ['reading:composed'] }),
      word({ id: 'b', headword: '臺灣原住民', pinyin: '族文化園區', glossEn: 'Táiwān' }),
    ];
    const changed = applyLexiconOverrides(words, [
      { headword: '噢', set: { pinyin: 'òu' }, reason: 'the interjection' },
      { id: 'b', set: { headword: '臺灣原住民族文化園區', glossEn: 'park' }, reason: 'a broken import' },
    ]);
    expect(changed).toEqual(['a', 'b']);
    expect(words[0]).toMatchObject({ pinyin: 'òu', zhuyin: 'ㄡˋ', tags: ['reading:override'] });
    expect(words[1]).toMatchObject({ headword: '臺灣原住民族文化園區', glossEn: 'park' });
    expect(words[1]!.chars).toHaveLength(10);
  });

  it('refuses a fix that matches nothing, and the shipped file loads', () => {
    expect(() => applyLexiconOverrides([], [{ id: 'x', set: {}, reason: 'nothing here at all' }])).toThrow();
    expect(loadLexiconOverrides(path.join(ROOT, 'data/supplement/lexicon-overrides.yaml')).length).toBeGreaterThan(3);
  });
});
