import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { isScenarioUnlocked, resolveScenarioVocabExtraIds, ScenarioSchema, type Scenario } from './scenario.js';

function word(id: string, headword: string): Word {
  return {
    id,
    headword,
    variants: [],
    pos: ['N'],
    level: null,
    source: 'supplement',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...headword],
    tags: [],
  };
}

const validScenario: Scenario = {
  id: 'tea-shop',
  title: 'Ordering a drink',
  levelRange: { min: 'N1', max: 'L2' },
  npc: { id: 'ayi', name: '阿姨', personality: 'friendly', speechStyle: 'short, casual', particles: ['喔', '啦'] },
  setting: 'A bubble tea counter.',
  goalSteps: [{ id: 'greet', description: 'Greet the shop', keywordHints: ['你好'] }],
  vocabExtras: ['珍珠奶茶', '少冰'],
  opener: { zh: '歡迎光臨！', en: 'Welcome!' },
  successLine: { zh: '謝謝，一杯25元。', en: 'Thanks, NT$25.' },
};

describe('ScenarioSchema', () => {
  it('accepts a well-formed scenario', () => {
    expect(ScenarioSchema.parse(validScenario)).toBeTruthy();
  });

  it('defaults keywordHints/particles/vocabExtras to [] when omitted', () => {
    const { vocabExtras: _vocabExtras, ...rest } = validScenario;
    const parsed = ScenarioSchema.parse({
      ...rest,
      npc: { id: 'ayi', name: '阿姨', personality: 'friendly', speechStyle: 'short' },
      goalSteps: [{ id: 'greet', description: 'Greet the shop' }],
    });
    expect(parsed.vocabExtras).toEqual([]);
    expect(parsed.npc.particles).toEqual([]);
    expect(parsed.goalSteps[0]!.keywordHints).toEqual([]);
  });

  it('rejects a scenario with no goal steps', () => {
    expect(() => ScenarioSchema.parse({ ...validScenario, goalSteps: [] })).toThrow();
  });

  it('rejects an invalid level in levelRange', () => {
    expect(() => ScenarioSchema.parse({ ...validScenario, levelRange: { min: 'N1', max: 'L9' } })).toThrow();
  });
});

describe('isScenarioUnlocked', () => {
  it('is unlocked inside the level range, inclusive', () => {
    expect(isScenarioUnlocked(validScenario, 'N1')).toBe(true);
    expect(isScenarioUnlocked(validScenario, 'L2')).toBe(true);
    expect(isScenarioUnlocked(validScenario, 'N2')).toBe(true);
  });

  it('is locked outside the level range', () => {
    expect(isScenarioUnlocked(validScenario, 'L3')).toBe(false);
  });
});

describe('resolveScenarioVocabExtraIds', () => {
  it('resolves headwords to lexicon ids', () => {
    const lexicon = new Lexicon([word('w1', '珍珠奶茶'), word('w2', '少冰')]);
    const { ids, missing } = resolveScenarioVocabExtraIds(validScenario, lexicon);
    expect(ids.sort()).toEqual(['w1', 'w2'].sort());
    expect(missing).toEqual([]);
  });

  it('reports missing headwords instead of throwing', () => {
    const lexicon = new Lexicon([word('w1', '珍珠奶茶')]);
    const { ids, missing } = resolveScenarioVocabExtraIds(validScenario, lexicon);
    expect(ids).toEqual(['w1']);
    expect(missing).toEqual(['少冰']);
  });
});
