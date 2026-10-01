import { describe, expect, it } from 'vitest';
import { LEECH_TREATMENTS } from './types.js';
import { nextLeechTreatment } from './leech.js';

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
