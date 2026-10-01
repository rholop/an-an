import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import type { Word } from '../types.js';
import { LEECH_TREATMENTS } from './types.js';
import { nextLeechTreatment, pickConfusableContrast, pickNewContextSentence } from './leech.js';

describe('nextLeechTreatment', () => {
  it('starts with new_context (first in the rotation) when nothing has been tried', () => {
    expect(nextLeechTreatment({ leechTreatmentsTried: [] })).toBe('new_context');
  });

  it('skips treatments already tried, in order', () => {
    expect(nextLeechTreatment({ leechTreatmentsTried: ['new_context'] })).toBe('char_breakdown');
    expect(nextLeechTreatment({ leechTreatmentsTried: ['new_context', 'char_breakdown'] })).toBe('mnemonic_prompt');
  });

  it('always returns one of the four defined treatments', () => {
    for (const tried of [[], ['new_context'], ['char_breakdown'], ['mnemonic_prompt'], ['contrast_confusable']] as const) {
      expect(LEECH_TREATMENTS).toContain(nextLeechTreatment({ leechTreatmentsTried: [...tried] }));
    }
  });

  it('wraps around once every treatment has been tried, rather than throwing', () => {
    const result = nextLeechTreatment({ leechTreatmentsTried: [...LEECH_TREATMENTS] });
    expect(LEECH_TREATMENTS).toContain(result);
  });
});

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: partial.headword,
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

describe('pickNewContextSentence', () => {
  const TARGET = word({ id: 'target1', headword: '珍珠奶茶' });
  const lexicon = new Lexicon([TARGET]);

  it('skips a sentence already shown and falls through to the next candidate', () => {
    const bankSentences: SentenceBankEntry[] = [
      { id: 's1', zh: '珍珠奶茶。', en: '', targetWordId: TARGET.id, level: 'N1', tokens: [], source: 'generated', doubtful: false },
      { id: 's2', zh: '珍珠奶茶！', en: '', targetWordId: TARGET.id, level: 'N1', tokens: [], source: 'generated', doubtful: false },
    ];
    const result = pickNewContextSentence(
      TARGET,
      { lexicon, knownIds: new Set(), learnerLevel: 'N1', bankSentences },
      new Set(['珍珠奶茶。']),
    );
    expect(result?.zh).toBe('珍珠奶茶！');
  });

  it('returns null once every candidate has already been shown', () => {
    const bankSentences: SentenceBankEntry[] = [
      { id: 's1', zh: '珍珠奶茶。', en: '', targetWordId: TARGET.id, level: 'N1', tokens: [], source: 'generated', doubtful: false },
    ];
    const result = pickNewContextSentence(
      TARGET,
      { lexicon, knownIds: new Set(), learnerLevel: 'N1', bankSentences },
      new Set(['珍珠奶茶。']),
    );
    expect(result).toBeNull();
  });
});

describe('pickConfusableContrast', () => {
  it('picks a same-level, shared-character confusable word', () => {
    const target = word({ id: 't1', headword: '快樂', pos: ['Vs'] });
    const confusable = word({ id: 'c1', headword: '快速', pos: ['Vs'] });
    const unrelated = word({ id: 'u1', headword: '桌子', pos: ['N'] });
    const lexicon = new Lexicon([target, confusable, unrelated]);

    const result = pickConfusableContrast(target, lexicon, () => 0);
    expect(result?.target.id).toBe(target.id);
    expect(result?.confusable.id).toBe(confusable.id);
  });

  it('returns null when the lexicon has nothing eligible to contrast against', () => {
    const target = word({ id: 't1', headword: '快樂' });
    const lexicon = new Lexicon([target]);
    expect(pickConfusableContrast(target, lexicon)).toBeNull();
  });
});
