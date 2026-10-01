import { describe, expect, it } from 'vitest';
import { Lexicon } from './lexicon.js';
import {
  applyPlacementRound,
  DEFAULT_PLACEMENT_CONFIG,
  initPlacementState,
  LEVEL_ORDER,
  nextPlacementRound,
  summarizePlacement,
  type PlacementState,
} from './placement.js';
import type { Level, Word } from './types.js';

function word(id: string, level: Level): Word {
  return {
    id,
    headword: id,
    variants: [],
    pos: ['N'],
    level,
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...id],
    tags: [],
  };
}

function buildFixtureLexicon(perLevel = 30): Lexicon {
  const words: Word[] = [];
  for (const level of LEVEL_ORDER) {
    for (let i = 0; i < perLevel; i++) words.push(word(`${level}-${i}`, level));
  }
  return new Lexicon(words);
}

/** Deterministic PRNG so sampling order is reproducible across test runs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drives the whole adaptive test against a "fake learner" who knows every
 * word at a level index strictly below `knowsUpToIndex` and nothing at or
 * above it — the idealized monotonic case the binary search assumes. */
function runPlacement(lexicon: Lexicon, knowsUpToIndex: number, seed = 1) {
  const rng = mulberry32(seed);
  let state: PlacementState = initPlacementState();
  let totalTaps = 0;
  const roundsLog: { level: Level; knownFraction: number }[] = [];

  for (let guard = 0; guard < 50; guard++) {
    const round = nextPlacementRound(state, lexicon, DEFAULT_PLACEMENT_CONFIG, rng);
    if (!round) break;
    const levelIdx = LEVEL_ORDER.indexOf(round.level);
    const answers = round.words.map(() => levelIdx < knowsUpToIndex);
    totalTaps += answers.length;
    roundsLog.push({ level: round.level, knownFraction: answers.filter(Boolean).length / answers.length });
    state = applyPlacementRound(state, round, answers, DEFAULT_PLACEMENT_CONFIG);
    if (state.phase === 'done') break;
  }

  return { state, totalTaps, roundsLog };
}

describe('placement test: adaptive binary search', () => {
  const lexicon = buildFixtureLexicon();

  it('finishes in well under 60 taps', () => {
    for (const boundary of [0, 1, 3, 4, 7, 8]) {
      const { totalTaps } = runPlacement(lexicon, boundary);
      expect(totalTaps).toBeLessThan(60);
      expect(totalTaps).toBeGreaterThan(0);
    }
  });

  it('converges on the correct boundary for a learner who knows up through L2 (index 3)', () => {
    const { state } = runPlacement(lexicon, 4); // knows indices 0..3 (N1,N2,L1,L2)
    const result = summarizePlacement(state);
    expect(result.boundaryLevelIndex).toBe(4);
    expect(result.boundaryLevel).toBe('L3');
  });

  it('converges correctly for a learner who knows nothing (absolute beginner)', () => {
    const { state } = runPlacement(lexicon, 0);
    const result = summarizePlacement(state);
    expect(result.boundaryLevelIndex).toBe(0);
    expect(result.boundaryLevel).toBe('N1');
  });

  it('converges correctly for a learner who knows everything', () => {
    const { state } = runPlacement(lexicon, LEVEL_ORDER.length);
    const result = summarizePlacement(state);
    expect(result.boundaryLevelIndex).toBe(LEVEL_ORDER.length);
    expect(result.boundaryLevel).toBeNull();
  });

  it('is deterministic given the same rng seed', () => {
    const a = runPlacement(lexicon, 4, 7);
    const b = runPlacement(lexicon, 4, 7);
    expect(a.state.judgements).toEqual(b.state.judgements);
  });

  it('never asks about the same word twice', () => {
    const { state } = runPlacement(lexicon, 4);
    const ids = state.judgements.map((j) => j.wordId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('spends confirm rounds near the found boundary, not far from it', () => {
    const { state, roundsLog } = runPlacement(lexicon, 4);
    const boundaryIdx = summarizePlacement(state).boundaryLevelIndex;
    const confirmLevels = roundsLog.slice(-DEFAULT_PLACEMENT_CONFIG.confirmRounds).map((r) => LEVEL_ORDER.indexOf(r.level));
    for (const idx of confirmLevels) {
      expect(Math.abs(idx - boundaryIdx)).toBeLessThanOrEqual(1);
    }
  });

  it('summarizePlacement tallies known/total per level matching the judgements', () => {
    const { state } = runPlacement(lexicon, 4);
    const result = summarizePlacement(state);
    for (const [level, tally] of Object.entries(result.byLevel)) {
      const levelJudgements = state.judgements.filter((j) => j.level === level);
      expect(tally!.total).toBe(levelJudgements.length);
      expect(tally!.known).toBe(levelJudgements.filter((j) => j.known).length);
    }
  });
});

describe('nextPlacementRound / applyPlacementRound: edge cases', () => {
  it('returns undefined immediately once phase is done', () => {
    const lexicon = buildFixtureLexicon(5);
    const done: PlacementState = { ...initPlacementState(), phase: 'done' };
    expect(nextPlacementRound(done, lexicon)).toBeUndefined();
  });

  it('gracefully stops when a level runs out of unseen words to sample', () => {
    const lexicon = buildFixtureLexicon(2); // only 2 words per level
    const rng = mulberry32(3);
    let state = initPlacementState();
    let rounds = 0;
    for (let i = 0; i < 50; i++) {
      const round = nextPlacementRound(state, lexicon, { ...DEFAULT_PLACEMENT_CONFIG, sampleSize: 7 }, rng);
      if (!round) break;
      rounds++;
      state = applyPlacementRound(state, round, round.words.map(() => true), DEFAULT_PLACEMENT_CONFIG);
    }
    expect(rounds).toBeGreaterThan(0); // made some progress before running dry, didn't throw
  });
});
