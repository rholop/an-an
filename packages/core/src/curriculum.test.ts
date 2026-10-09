import { LAST_LEVEL, LEVEL_IDS } from './levels.config.js';
import { describe, expect, it } from 'vitest';
import { levelNewCandidates } from './curriculum.js';
import { emptyCard } from './learner/fsrs-instance.js';
import type { SkillCard } from './learner/types.js';
import { Lexicon } from './lexicon.js';
import type { Word } from './types.js';
import { buildLedger } from './progress/ledger.js';
import { DEFAULT_SESSION_SETTINGS } from './progress/review-sessions.js';
import { DEFAULT_STUDY_SETTINGS } from './study/study-focus.js';

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

const NOW = new Date('2026-01-01T12:00:00Z');

function strongCard(id: string): SkillCard {
  return {
    item: { kind: 'word', id },
    skill: 'recognition',
    card: { ...emptyCard(NOW), stability: 30, reps: 3, state: 2, due: new Date('2026-03-01') },
    state: 'mature',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: NOW,
  };
}

const ledgerOf = (words: Word[], cards: SkillCard[], level?: Word['level']) =>
  buildLedger({
    cards,
    evidence: [],
    knownItems: [],
    session: DEFAULT_SESSION_SETTINGS,
    masteryShare: 0.9,
    now: NOW,
    study: { lexicon: new Lexicon(words), books: [], settings: DEFAULT_STUDY_SETTINGS, ...(level ? { level } : {}) },
  });

describe('ledger.level (Phase 29: level coverage is the ledger\'s)', () => {
  const words = [word({ id: 'a', headword: '一', level: 'N1' }), word({ id: 'b', headword: '二', level: 'N1' })];

  it('a level with no words has nothing to cover and never suggests moving up', () => {
    const v = ledgerOf(words, []).level('L5');
    expect(v.learnedShare).toBe(1);
    expect(v.readyForNext).toBe(false);
  });

  it('counts Learned words (recognition), not production cards', () => {
    expect(ledgerOf(words, []).level('N1').learnedShare).toBe(0);
    const cards = [strongCard('a'), { ...strongCard('b'), skill: 'production' as const }];
    expect(ledgerOf(words, cards).level('N1').learnedShare).toBe(0.5);
  });

  it('leaves removed words out of the level', () => {
    const cards = [strongCard('a'), { ...strongCard('b'), state: 'introduced' as const, flags: { excluded: true } }];
    expect(ledgerOf(words, cards).level('N1')).toMatchObject({ total: 1, learned: 1, readyForNext: true, next: 'N2' });
  });
});

describe('ledger.frontierLevel', () => {
  const words: Word[] = [word({ id: 'n1-a', headword: '一', level: 'N1' }), word({ id: 'n2-a', headword: '二', level: 'N2' })];

  it('starts at N1 with nothing learned, advances past a covered level, stays on the last level', () => {
    expect(ledgerOf(words, []).frontierLevel()).toBe('N1');
    expect(ledgerOf(words, [strongCard('n1-a')]).frontierLevel()).toBe('N2');
    expect(ledgerOf(words, [strongCard('n1-a'), strongCard('n2-a')]).frontierLevel()).toBe(LAST_LEVEL);
  });
});

describe('levelNewCandidates (the candidates of the one new-word picker without a study focus)', () => {
  const words: Word[] = [
    word({ id: 'n1-1', headword: '一', level: 'N1', freqRank: 1 }),
    word({ id: 'n1-2', headword: '二', level: 'N1', freqRank: 2 }),
    word({ id: 'n1-3', headword: '三', level: 'N1', freqRank: 3 }),
    word({ id: 'n2-1', headword: '四', level: 'N2', freqRank: 1 }),
    word({ id: 'supp-1', headword: '喔', level: null, source: 'supplement' }),
  ];
  const lexicon = new Lexicon(words);
  const base = { lexicon, level: 'N1' as const, nextLevelToo: false, carded: new Set<string>(), knownChars: new Set<string>() };

  it('the level\'s words by frequency, never supplement words, never a word with a card', () => {
    expect(levelNewCandidates(base).map((i) => i.id)).toEqual(['n1-1', 'n1-2', 'n1-3']);
    expect(levelNewCandidates({ ...base, carded: new Set(['n1-1']) }).map((i) => i.id)).toEqual(['n1-2', 'n1-3']);
  });

  it('prefers words tagged with a scenario tag, and adds the next level only when asked', () => {
    const tagged = new Lexicon([...words, word({ id: 'n1-r', headword: '甲', level: 'N1', freqRank: 99, tags: ['restaurant'] })]);
    expect(levelNewCandidates({ ...base, lexicon: tagged, scenarioTags: ['restaurant'] })[0]!.id).toBe('n1-r');
    expect(levelNewCandidates({ ...base, nextLevelToo: true }).map((i) => i.id)).toContain('n2-1');
  });

  it('the ledger picks from them under the allowance when there is no study focus', () => {
    const picked = ledgerOf(words, [], 'N1').pickNew('review');
    expect(picked.items.map((i) => i.id)).toEqual(['n1-1', 'n1-2', 'n1-3']);
  });
});

describe('Level type sanity', () => {
  it('N1 and N2 sort before L1..L5', () => {
    expect(LEVEL_IDS.slice(0, 3)).toEqual(['N1', 'N2', 'L1']);
  });
});
