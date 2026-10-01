import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { pickDistractors } from './distractors.js';

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

const target = word({ id: 't1', headword: '快樂', glossEn: 'happy', pos: ['Vs'] });
const variantOfTarget = word({ id: 't1b', headword: '快乐', glossEn: 'happy (variant)' });
// Give the real target a variant spelling so the variant-exclusion branch is exercised.
const targetWithVariant: Word = { ...target, variants: ['快乐'] };

const synonym = word({ id: 's1', headword: '愉快', glossEn: 'happy', pos: ['Vs'] });
const sharesChar = word({ id: 's2', headword: '快速', glossEn: 'fast', pos: ['Vs'] });
const samePos = word({ id: 's3', headword: '悲傷', glossEn: 'sad', pos: ['Vs'] });
const unrelated = word({ id: 's4', headword: '桌子', glossEn: 'table', pos: ['N'] });
const outOfLevel = word({ id: 's5', headword: '憂鬱', glossEn: 'melancholy', level: 'L5', pos: ['Vs'] });

const lexicon = new Lexicon([targetWithVariant, variantOfTarget, synonym, sharesChar, samePos, unrelated, outOfLevel]);

describe('pickDistractors', () => {
  it('never includes the target itself', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 10 });
    expect(picks.some((w) => w.id === targetWithVariant.id)).toBe(false);
  });

  it('excludes a spelling variant of the target (also a correct answer)', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 10 });
    expect(picks.some((w) => w.id === variantOfTarget.id)).toBe(false);
  });

  it('excludes a same-gloss synonym (also a correct answer) — the acceptance criterion case', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 10 });
    expect(picks.some((w) => w.id === synonym.id)).toBe(false);
  });

  it('excludes out-of-level words', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 10 });
    expect(picks.some((w) => w.id === outOfLevel.id)).toBe(false);
  });

  it('respects the requested count, capped by pool size', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 2 });
    expect(picks).toHaveLength(2);
  });

  it('returns fewer than requested rather than padding when the pool runs out', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 50 });
    // Eligible pool: sharesChar, samePos, unrelated (3) — synonym/variant/out-of-level excluded.
    expect(picks).toHaveLength(3);
  });

  it('preferConfusable ranks shared-character/same-POS words ahead of unrelated ones', () => {
    const rng = () => 0; // deterministic — no shuffling within a tier
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 2, preferConfusable: true }, rng);
    const ids = picks.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([sharesChar.id, samePos.id]));
    expect(ids).not.toContain(unrelated.id);
  });

  it('without preferConfusable, the unrelated word is still a valid (if less ideal) pick', () => {
    const picks = pickDistractors(targetWithVariant, lexicon, { count: 3 });
    const ids = picks.map((w) => w.id);
    expect(ids).toContain(unrelated.id);
  });
});
