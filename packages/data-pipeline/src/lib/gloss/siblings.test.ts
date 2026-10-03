import { describe, expect, it } from 'vitest';
import type { Word } from '@anan/core';
import { diversifySiblingGlosses } from './siblings.js';

const sense = (n: number, id: string, glossEn: string) => ({ id: `${id}#${n}`, glossEn, basedOn: ['cedict'] });
function w(id: string, headword: string, level: Word['level'], pos: string[], glosses: string[], extra: Partial<Word> = {}): Word {
  const senses = glosses.map((g, i) => sense(i + 1, id, g));
  return {
    id, headword, variants: [], pos, level, source: 'tocfl', pinyin: 'x', pinyinNumeric: '', zhuyin: '',
    glossEn: glosses[0]!, senses, primarySenseId: senses[0]!.id, glossSources: ['cedict'], chars: [...headword], tags: [], ...extra,
  };
}

describe('diversifySiblingGlosses', () => {
  it('gives a particle sibling a particle gloss instead of the verb gloss it duplicates (去)', () => {
    const verb = w('a', '去', 'N1', ['V'], ['to go', 'to go in order to do']);
    const ptc = w('b', '去', 'L3', ['Ptc'], ['to go', 'to remove', '(used after certain verbs) away from the speaker']);
    const fixes = diversifySiblingGlosses([ptc, verb]);
    expect(verb.glossEn).toBe('to go');
    expect(ptc.glossEn).toBe('(used after certain verbs) away from the speaker');
    expect(ptc.primarySenseId).toBe('b#3');
    expect(ptc.senses![0]!.id).toBe('b#3');
    expect(ptc.tags).toContain('gloss:sibling-diversified');
    expect(fixes).toEqual([{ wordId: 'b', headword: '去', from: 'to go', to: '(used after certain verbs) away from the speaker' }]);
  });

  it('leaves same-meaning siblings alone (碗 noun / measure word)', () => {
    const noun = w('a', '碗', 'N2', ['N'], ['bowl', 'cup']);
    const m = w('b', '碗', 'L1', ['M'], ['bowl', 'cup']);
    expect(diversifySiblingGlosses([noun, m])).toEqual([]);
    expect(m.glossEn).toBe('bowl');
  });

  it('reports a misfit sibling with no better sense instead of guessing', () => {
    const verb = w('a', '去', 'N1', ['V'], ['to go']);
    const ptc = w('b', '去', 'L3', ['Ptc'], ['to go', 'to remove']);
    expect(diversifySiblingGlosses([verb, ptc])).toEqual([{ wordId: 'b', headword: '去', from: 'to go', to: null }]);
    expect(ptc.glossEn).toBe('to go');
  });

  it('does not promote junk senses such as I Ching hexagrams (隨)', () => {
    const verb = w('a', '隨', 'L4', ['V'], ['to follow']);
    const adv = w('b', '隨', 'L5', ['Adv'], ['to follow', '17th hexagram of the I Ching']);
    expect(diversifySiblingGlosses([verb, adv])).toEqual([{ wordId: 'b', headword: '隨', from: 'to follow', to: null }]);
  });

  it('never touches hand overrides or words with different readings', () => {
    const verb = w('a', '去', 'N1', ['V'], ['to go']);
    const ptc = w('b', '去', 'L3', ['Ptc'], ['to go', 'particle marker'], { tags: ['gloss:override'] });
    const other = w('c', '去', 'L3', ['Ptc'], ['to go', 'particle marker'], { pinyin: 'y' });
    expect(diversifySiblingGlosses([verb, ptc, other])).toEqual([]);
  });
});
