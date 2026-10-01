import { describe, expect, it } from 'vitest';
import { MAINLAND_TERMS } from '../data/mainland-terms.generated.js';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import type { ClozeSourceCandidate } from './source.js';
import {
  buildClozeExercise,
  buildLePlacementExercise,
  buildMainlandVsTaiwanExercise,
  buildMultipleChoiceOptions,
  buildProductionPrompt,
  buildReorderExercise,
  buildWordBankOptions,
  LE_PLACEMENT_EXAMPLES,
} from './exercise.js';

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

const TARGET = word({ id: 'target1', headword: '珍珠奶茶', glossEn: 'bubble tea' });
const OTHER1 = word({ id: 'o1', headword: '快速', glossEn: 'fast' });
const OTHER2 = word({ id: 'o2', headword: '悲傷', glossEn: 'sad' });
const OTHER3 = word({ id: 'o3', headword: '桌子', glossEn: 'table' });
const OTHER4 = word({ id: 'o4', headword: '椅子', glossEn: 'chair' });
const KNOWN = ['我', '想', '喝', '一杯', '很', '好喝', '要'].map((hw, i) => word({ id: `k${i}`, headword: hw }));

const lexicon = new Lexicon([TARGET, OTHER1, OTHER2, OTHER3, OTHER4, ...KNOWN]);

describe('buildClozeExercise', () => {
  const source: ClozeSourceCandidate = {
    zh: '我想喝一杯珍珠奶茶。',
    sourceKind: 'bank',
    sourceLabel: 'example sentence',
  };

  it('locates the target word and blanks the right span', () => {
    const exercise = buildClozeExercise(TARGET, source, lexicon);
    expect(exercise).not.toBeNull();
    expect(source.zh.slice(exercise!.blankStart, exercise!.blankEnd)).toBe('珍珠奶茶');
    expect(exercise!.answer.id).toBe(TARGET.id);
    expect(exercise!.sourceLabel).toBe('example sentence');
  });

  it('matches via a variant spelling too', () => {
    const withVariant: Word = { ...TARGET, variants: ['珍奶'] };
    const variantLexicon = new Lexicon([withVariant, ...KNOWN]);
    const variantSource: ClozeSourceCandidate = { zh: '我要珍奶。', sourceKind: 'chat', sourceLabel: 'from your chat' };
    const exercise = buildClozeExercise(withVariant, variantSource, variantLexicon);
    expect(exercise).not.toBeNull();
    expect(variantSource.zh.slice(exercise!.blankStart, exercise!.blankEnd)).toBe('珍奶');
  });

  it('returns null when the word cannot be found in the sentence', () => {
    const noMatchSource: ClozeSourceCandidate = { zh: '今天天氣很好。', sourceKind: 'bank', sourceLabel: 'example sentence' };
    expect(buildClozeExercise(TARGET, noMatchSource, lexicon)).toBeNull();
  });
});

describe('buildWordBankOptions / buildMultipleChoiceOptions', () => {
  it('word bank includes the answer among up to 5 options', () => {
    const options = buildWordBankOptions(TARGET, lexicon);
    expect(options.length).toBeLessThanOrEqual(5);
    expect(options.some((o) => o.isCorrect && o.word.id === TARGET.id)).toBe(true);
    expect(options.filter((o) => o.isCorrect)).toHaveLength(1);
  });

  it('multiple choice includes the answer among up to 4 options', () => {
    const options = buildMultipleChoiceOptions(TARGET, lexicon);
    expect(options.length).toBeLessThanOrEqual(4);
    expect(options.filter((o) => o.isCorrect)).toHaveLength(1);
  });

  it('never offers two "correct" options', () => {
    const options = buildMultipleChoiceOptions(TARGET, lexicon);
    expect(options.filter((o) => o.isCorrect)).toHaveLength(1);
  });
});

describe('buildReorderExercise', () => {
  it('shuffled contains exactly the same tokens as the original, in some order', () => {
    const result = buildReorderExercise('我想喝一杯珍珠奶茶。', lexicon);
    expect([...result.shuffled].sort()).toEqual([...result.correctOrder].sort());
  });

  it('reshuffles rather than returning the trivially-already-correct order', () => {
    // '我喝' segments to exactly 2 tokens, so Fisher-Yates makes one swap
    // decision: rng() >= 0.5 keeps the identity order (the no-op case this
    // guard exists for); the next rng() call (0.1) forces a real swap.
    const calls = [0.9, 0.1];
    let i = 0;
    const rng = () => calls[i++] ?? 0.1;
    const result = buildReorderExercise('我喝', lexicon, rng);
    expect(result.correctOrder).toEqual(['我', '喝']);
    expect(result.shuffled).toEqual(['喝', '我']);
  });
});

describe('buildProductionPrompt', () => {
  it('prompts with the English gloss and accepts the headword + variants', () => {
    const withVariant: Word = { ...TARGET, variants: ['珍奶'] };
    const prompt = buildProductionPrompt(withVariant);
    expect(prompt.en).toBe(TARGET.glossEn);
    expect(prompt.accepted).toEqual(['珍珠奶茶', '珍奶']);
  });
});

describe('buildMainlandVsTaiwanExercise', () => {
  it('rng=0 picks the first MAINLAND_TERMS entry, with the Taiwan spelling at optionA', () => {
    const result = buildMainlandVsTaiwanExercise(() => 0);
    expect(result.correctIndex).toBe(0);
    expect(result.optionA).toBe(MAINLAND_TERMS[0]!.taiwan);
    expect(result.optionB).toBe(MAINLAND_TERMS[0]!.mainland[0]);
  });

  it('the option at correctIndex is always the Taiwan spelling of the picked entry, never the mainland one', () => {
    for (const rngValue of [0, 0.3, 0.6, 0.9]) {
      const entry = MAINLAND_TERMS[Math.floor(rngValue * MAINLAND_TERMS.length)]!;
      const result = buildMainlandVsTaiwanExercise(() => rngValue);
      const correctOption = result.correctIndex === 0 ? result.optionA : result.optionB;
      expect(correctOption).toBe(entry.taiwan);
    }
  });
});

describe('buildLePlacementExercise', () => {
  it('the correct option is always a well-formed sentence from the curated set', () => {
    const result = buildLePlacementExercise(() => 0);
    const correctOption = result.correctIndex === 0 ? result.optionA : result.optionB;
    expect(LE_PLACEMENT_EXAMPLES.some((e) => e.correct === correctOption)).toBe(true);
  });
});
