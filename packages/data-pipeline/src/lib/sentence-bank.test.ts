import { describe, expect, it } from 'vitest';
import { Lexicon, type Word } from '@anan/core';
import { buildAnalyzeContext, isDoubtful, sampleAllowedVocab, shuffle } from './sentence-bank.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

describe('shuffle', () => {
  it('returns a permutation of the same elements', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = shuffle(arr, Math.random);
    expect([...result].sort()).toEqual(arr);
  });

  it('does not mutate the input array', () => {
    const arr = [1, 2, 3];
    const copy = [...arr];
    shuffle(arr, Math.random);
    expect(arr).toEqual(copy);
  });
});

describe('sampleAllowedVocab', () => {
  const target = word({ id: 'target1', headword: '珍珠奶茶' });
  const filler1 = word({ id: 'f1', headword: '我' });
  const filler2 = word({ id: 'f2', headword: '很' });
  const other1 = word({ id: 'o1', headword: '桌子' });
  const other2 = word({ id: 'o2', headword: '椅子' });
  const pool = [target, filler1, filler2, other1, other2];

  it('always includes the core fillers present in the pool', () => {
    const result = sampleAllowedVocab(target, pool, ['我', '很'], 10, Math.random);
    expect(result).toContain('我');
    expect(result).toContain('很');
  });

  it('never includes the target word itself', () => {
    const result = sampleAllowedVocab(target, pool, ['我', '很'], 10, Math.random);
    expect(result).not.toContain('珍珠奶茶');
  });

  it('respects the sample size cap', () => {
    const result = sampleAllowedVocab(target, pool, ['我', '很'], 3, Math.random);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('fills remaining slots with other pool words up to the cap', () => {
    const result = sampleAllowedVocab(target, pool, ['我', '很'], 4, () => 0);
    expect(result).toHaveLength(4);
  });
});

describe('isDoubtful', () => {
  it('flags a sentence shorter than 4 characters', () => {
    expect(isDoubtful('我去')).toBe(true);
  });

  it('flags a sentence longer than 30 characters', () => {
    expect(isDoubtful('我'.repeat(31))).toBe(true);
  });

  it('does not flag a normal-length sentence', () => {
    expect(isDoubtful('我想喝一杯珍珠奶茶。')).toBe(false);
  });
});

describe('buildAnalyzeContext', () => {
  it('uses the word level as learnerLevel and treats the word itself as a target', () => {
    const target = word({ id: 'target1', headword: '珍珠奶茶', level: 'N2' });
    const lexicon = new Lexicon([target]);
    const ctx = buildAnalyzeContext(target, lexicon, new Set(['f1']));
    expect(ctx.learnerLevel).toBe('N2');
    expect(ctx.targetIds.has('target1')).toBe(true);
    expect(ctx.knownIds.has('f1')).toBe(true);
  });

  it('falls back to L6 when the word has no level', () => {
    const target = word({ id: 'target1', headword: '某詞', level: null });
    const lexicon = new Lexicon([target]);
    const ctx = buildAnalyzeContext(target, lexicon, new Set());
    expect(ctx.learnerLevel).toBe('L6');
  });
});
