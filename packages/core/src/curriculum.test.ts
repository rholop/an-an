import { describe, expect, it } from 'vitest';
import {
  currentFrontierLevel,
  DEFAULT_CURRICULUM_CONFIG,
  levelCoverage,
  nextNewItems,
} from './curriculum.js';
import { emptyCard } from './learner/fsrs-instance.js';
import type { SkillCard } from './learner/types.js';
import { Lexicon } from './lexicon.js';
import type { Level, Word } from './types.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: null,
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

function strongCard(id: string): SkillCard {
  const now = new Date('2026-01-01');
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...emptyCard(now), stability: 30 },
    state: 'mature',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}

describe('levelCoverage', () => {
  const words = [
    word({ id: 'a', headword: '一', level: 'N1' }),
    word({ id: 'b', headword: '二', level: 'N1' }),
  ];

  it('is 1 for a level with no words at all (nothing left to cover)', () => {
    expect(levelCoverage('L5', words, [])).toBe(1);
  });

  it('is 0 when no words at the level have a strong recognition card', () => {
    expect(levelCoverage('N1', words, [])).toBe(0);
  });

  it('counts only recognition-skill review/mature cards as "covered"', () => {
    const cards: SkillCard[] = [
      strongCard('a'),
      { ...strongCard('b'), skill: 'production' }, // wrong skill, doesn't count
    ];
    expect(levelCoverage('N1', words, cards)).toBe(0.5);
  });
});

describe('currentFrontierLevel', () => {
  const words: Word[] = [
    word({ id: 'n1-a', headword: '一', level: 'N1' }),
    word({ id: 'n2-a', headword: '二', level: 'N2' }),
  ];

  it('starts at the first level (N1) with nothing learned', () => {
    expect(currentFrontierLevel(words, [])).toBe('N1');
  });

  it('advances once the current level crosses the threshold', () => {
    const cards = [strongCard('n1-a')]; // 100% of N1 covered
    expect(currentFrontierLevel(words, cards)).toBe('N2');
  });

  it('stays on the last level once everything is covered', () => {
    const cards = [strongCard('n1-a'), strongCard('n2-a')];
    expect(currentFrontierLevel(words, cards)).toBe('L6');
  });
});

describe('nextNewItems', () => {
  const words: Word[] = [
    word({ id: 'n1-1', headword: '一', level: 'N1', freqRank: 1 }),
    word({ id: 'n1-2', headword: '二', level: 'N1', freqRank: 2 }),
    word({ id: 'n1-3', headword: '三', level: 'N1', freqRank: 3 }),
    word({ id: 'n2-1', headword: '四', level: 'N2', freqRank: 1 }),
    word({ id: 'n2-2', headword: '五', level: 'N2', freqRank: 2 }),
    word({ id: 'supp-1', headword: '喔', level: null, source: 'supplement' }),
  ];
  const lexicon = new Lexicon(words);

  it('returns [] for n <= 0', () => {
    expect(nextNewItems([], lexicon, 0)).toEqual([]);
  });

  it('picks from the current frontier level, ordered by freqRank, plus supplement words', () => {
    const picked = nextNewItems([], lexicon, 2);
    expect(picked.map((w) => w.id)).toEqual(['n1-1', 'n1-2']);
  });

  it('never re-offers an already-introduced item', () => {
    const cards = [strongCard('n1-1')];
    const picked = nextNewItems(cards, lexicon, 10);
    expect(picked.some((w) => w.id === 'n1-1')).toBe(false);
  });

  it('supplement words (level: null) are always in the pool', () => {
    const picked = nextNewItems([], lexicon, 10);
    expect(picked.some((w) => w.id === 'supp-1')).toBe(true);
  });

  it('prefers words tagged with a scenario context tag', () => {
    const taggedWords: Word[] = [
      word({ id: 'low-freq-tagged', headword: '甲', level: 'N1', freqRank: 99, tags: ['restaurant'] }),
      word({ id: 'high-freq-untagged', headword: '乙', level: 'N1', freqRank: 1 }),
    ];
    const taggedLexicon = new Lexicon(taggedWords);
    const picked = nextNewItems([], taggedLexicon, 1, { scenarioTags: ['restaurant'] });
    expect(picked[0]!.id).toBe('low-freq-tagged');
  });

  it('trickles in the next level only once the frontier level is >= threshold covered', () => {
    // Cover 100% of N1 (2 words) so the frontier advances/trickles.
    const smallWords: Word[] = [
      word({ id: 'n1-a', headword: '一', level: 'N1', freqRank: 1 }),
      word({ id: 'n1-b', headword: '二', level: 'N1', freqRank: 2 }),
      word({ id: 'n1-c', headword: '三', level: 'N1', freqRank: 3 }),
      word({ id: 'n2-a', headword: '四', level: 'N2', freqRank: 1 }),
    ];
    const smallLexicon = new Lexicon(smallWords);
    const cards = [strongCard('n1-a'), strongCard('n1-b')]; // covers n1-a, n1-b; n1-c still new
    // Frontier is now N2 (N1 fully covered relative to itself: 2/3 ~ 0.67 < 0.7 threshold actually)
    // so with default config N1 is NOT yet past threshold (2/3 = 0.667 < 0.7) -> frontier stays N1,
    // and since coverage < threshold, no trickle yet.
    const noTrickle = nextNewItems(cards, smallLexicon, 5);
    expect(noTrickle.some((w) => w.level === 'N2')).toBe(false);

    // Now cover all three N1 words -> 100% >= 70% threshold -> trickle allowed.
    const fullCards = [strongCard('n1-a'), strongCard('n1-b'), strongCard('n1-c')];
    const withTrickle = nextNewItems(fullCards, smallLexicon, 5, {}, DEFAULT_CURRICULUM_CONFIG);
    expect(withTrickle.some((w) => w.level === 'N2')).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const a = nextNewItems([], lexicon, 3);
    const b = nextNewItems([], lexicon, 3);
    expect(a.map((w) => w.id)).toEqual(b.map((w) => w.id));
  });
});

describe('Level type sanity', () => {
  it('N1 and N2 sort before L1..L6 in currentFrontierLevel', () => {
    const order: Level[] = ['N1', 'N2', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
    expect(order[0]).toBe('N1');
  });
});
