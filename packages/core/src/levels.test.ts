import { describe, expect, it } from 'vitest';
import { LevelSchema } from './chat/level-schema.js';
import { scenarioMatchesLevels, type Scenario } from './chat/scenario.js';
import { selectClozeSource } from './cloze/source.js';
import { buildSession } from './cloze/session.js';
import { buildLedger } from './progress/ledger.js';
import { DEFAULT_SESSION_SETTINGS } from './progress/review-sessions.js';
import { DEFAULT_STUDY_SETTINGS } from './study/study-focus.js';
import { pickPromptWords } from './journal/prompts.js';
import { summarizeLevels } from './journal/summary.js';
import { emptyCard } from './learner/fsrs-instance.js';
import type { SkillCard } from './learner/types.js';
import { Lexicon } from './lexicon.js';
import {
  FIRST_LEVEL,
  LAST_LEVEL,
  LEVEL_IDS,
  LEVELS,
  isLevel,
  levelIndex,
  levelLabel,
  levelShort,
  tocflLabel,
  nextLevel,
} from './levels.config.js';
import type { Level, Word } from './types.js';

const word = (
  id: string,
  headword: string,
  level: Level | null,
  over: Partial<Word> = {},
): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level,
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [...headword],
  tags: [],
  ...over,
});

const card = (id: string, over: Partial<SkillCard> = {}): SkillCard => ({
  item: { kind: 'word', id },
  skill: 'recognition',
  card: { ...emptyCard(new Date('2026-01-01')), reps: 2 },
  state: 'review',
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  clozeRung: 1,
  clozeStreak: 0,
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  updatedAt: new Date('2026-01-01'),
  ...over,
});

describe('levels.config', () => {
  it('defines exactly the seven 2023 TOCFL levels, in order, once', () => {
    expect(LEVEL_IDS).toEqual(['N1', 'N2', 'L1', 'L2', 'L3', 'L4', 'L5']);
    expect(LEVELS.map((l) => l.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(LEVELS.map((l) => l.nameZh)).size).toBe(7);
    expect(FIRST_LEVEL).toBe('N1');
    expect(LAST_LEVEL).toBe('L5');
    expect(LEVEL_IDS.includes('L6' as Level)).toBe(false);
  });

  it('labels and helpers', () => {
    expect(levelLabel('L2')).toBe('L2 基礎級 · A2');
    expect(levelLabel('N1')).toBe('N1 準備級一級 · pre-A1');
    expect(levelShort('L3')).toBe('L3');
    expect(tocflLabel('N2')).toBe('TOCFL N2');
    expect(levelIndex('L1')).toBe(2);
    expect(nextLevel('L4')).toBe('L5');
    expect(nextLevel('L5')).toBeNull();
    expect(isLevel('L5')).toBe(true);
    expect(isLevel('L6')).toBe(false);
  });

  it('the zod schema is derived from the config', () => {
    expect(LevelSchema.options).toEqual([...LEVEL_IDS]);
    expect(LevelSchema.safeParse('L6').success).toBe(false);
  });
});

describe('chosen level drives the curriculum', () => {
  const words = [
    word('n1', '一', 'N1'),
    word('n2', '二', 'N2'),
    word('l1a', '三', 'L1', { freqRank: 1 }),
    word('l3a', '四', 'L3', { freqRank: 1 }),
    word('l3b', '五', 'L3', { freqRank: 2 }),
  ];
  const lexicon = new Lexicon(words);

  const ledger = (cards: SkillCard[], level?: Level) =>
    buildLedger({
      cards,
      evidence: [],
      knownItems: [],
      session: DEFAULT_SESSION_SETTINGS,
      masteryShare: 0.9,
      now: new Date('2026-01-02'),
      study: { lexicon, books: [], settings: DEFAULT_STUDY_SETTINGS, ...(level ? { level } : {}) },
    });

  it('new words come from the chosen level, not the derived frontier', () => {
    expect(ledger([], 'L3').pickNew('review', { allowed: 2 }).items.map((i) => i.id)).toEqual(['l3a', 'l3b']);
    // without a chosen level it falls back to the progress-derived frontier (N1)
    expect(ledger([]).pickNew('review', { allowed: 1 }).items.map((i) => i.id)).toEqual(['n1']);
  });

  it('suggests (never forces) the next level at 70% coverage', () => {
    expect(ledger([]).level('N1').next).toBeUndefined();
    expect(ledger([card('n1')]).level('N1').next).toBe('N2');
    expect(ledger([]).level('L5').next).toBeUndefined();
  });

  it('never hides due reviews, whatever level is chosen', () => {
    const due = [card('n1'), card('l1a'), card('l3a'), card('l3b')];
    for (const level of LEVEL_IDS) {
      const session = buildSession(due, {
        lexicon,
        knownIds: new Set(),
        learnerLevel: level,
        rng: () => 0.5,
      });
      expect(session.map((s) => s.word.id).sort()).toEqual(['l1a', 'l3a', 'l3b', 'n1']);
    }
  });

  it('prefers bank sentences at or below the chosen level', () => {
    const target = word('t', '茶', 'L1');
    const lex = new Lexicon([target, word('x', '喝', 'N1'), word('w', '我', 'N1')]);
    const bank = (id: string, level: Level) => ({
      id,
      zh: '我喝茶',
      en: 'x',
      targetWordId: 't',
      level,
      tokens: [],
      source: 'generated' as const,
      doubtful: false,
    });
    const pick = (learnerLevel: Level) =>
      selectClozeSource(target, {
        lexicon: lex,
        knownIds: new Set(['x', 'w']),
        learnerLevel,
        bankSentences: [
          { ...bank('high', 'L4'), zh: '我喝茶。' },
          { ...bank('low', 'L1'), zh: '我喝茶' },
        ],
      })?.zh;
    expect(pick('L1')).toBe('我喝茶'); // the L1 sentence wins over the earlier-listed L4 one
    expect(pick('L5')).toBe('我喝茶。'); // both are at/below L5: original order kept
  });
});

describe('journal and scenarios relative to the chosen level', () => {
  const lexicon = new Lexicon([
    word('a', '我', 'N1'),
    word('b', '喜歡', 'L2'),
    word('c', '貓', 'L4'),
  ]);

  it('prompt words at/below the level come first', () => {
    const due = [card('c'), card('b'), card('a')];
    const picks = pickPromptWords(due, lexicon, new Date('2026-06-01'), 2, 'L2');
    expect(picks.map((w) => w.headword).sort()).toEqual(['喜歡', '我']);
    expect(
      pickPromptWords(due, lexicon, new Date('2026-06-01'), 3, 'L2').map((w) => w.headword),
    ).toContain('貓');
  });

  it('the level summary is relative to the chosen level', () => {
    expect(summarizeLevels('我喜歡貓', lexicon, 'L2').headline).toContain('above your level (L2)');
    expect(summarizeLevels('我喜歡貓', lexicon, 'L4').headline).toContain(
      'all within your level (L4)',
    );
    expect(summarizeLevels('我喜歡貓', lexicon).headline).not.toContain('your level');
  });

  it('scenario level filter intersects the scenario range', () => {
    const s = { levelRange: { min: 'L1', max: 'L3' } } as Scenario;
    expect(scenarioMatchesLevels(s, ['L2'])).toBe(true);
    expect(scenarioMatchesLevels(s, ['N1', 'L5'])).toBe(false);
    expect(scenarioMatchesLevels(s, ['N1', 'L3'])).toBe(true);
    expect(scenarioMatchesLevels(s, [])).toBe(true);
  });
});
