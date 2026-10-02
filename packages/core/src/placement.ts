import type { Lexicon } from './lexicon.js';
import { LEVEL_IDS } from './levels.config.js';
import type { Level, Word } from './types.js';

export const LEVEL_ORDER: Level[] = [...LEVEL_IDS];

export interface PlacementConfig {
  /** Words sampled per round. */
  sampleSize: number;
  /** Fraction of a round's words marked "I know this" at/above which the
   * learner is considered to know that level. */
  knownThreshold: number;
  /** Extra rounds, right at the found boundary, to pin down individual
   * words near the transition rather than trusting the level-wide average. */
  confirmRounds: number;
}

export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = {
  sampleSize: 7,
  knownThreshold: 0.5,
  confirmRounds: 2,
}; // ~4 binary-search rounds + 2 confirm rounds, 7 words/round = ~42 taps; see placement.test.ts.

export interface PlacementJudgement {
  wordId: string;
  level: Level;
  known: boolean;
}

export type PlacementPhase = 'searching' | 'confirming' | 'done';

export interface PlacementState {
  lo: number;
  hi: number;
  phase: PlacementPhase;
  judgements: PlacementJudgement[];
  askedWordIds: Set<string>;
  confirmRoundsDone: number;
}

export function initPlacementState(): PlacementState {
  return {
    lo: 0,
    hi: LEVEL_ORDER.length, // sentinel: "boundary is past the last level" until narrowed
    phase: 'searching',
    judgements: [],
    askedWordIds: new Set(),
    confirmRoundsDone: 0,
  };
}

export interface PlacementRound {
  level: Level;
  words: Word[];
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function sampleLevel(
  level: Level,
  lexicon: Lexicon,
  askedWordIds: ReadonlySet<string>,
  n: number,
  rng: () => number,
): Word[] {
  const pool = lexicon.allWords().filter((w) => w.level === level && !askedWordIds.has(w.id));
  return shuffled(pool, rng).slice(0, n);
}

/** Current boundary index while searching (standard "first index where the
 * monotonic known-ness predicate goes false" binary search midpoint). */
function searchMid(state: PlacementState): number {
  return Math.floor((state.lo + state.hi) / 2);
}

/**
 * Next batch of words to ask the learner about, or `undefined` once the test
 * is done (phase 'done'). Call `applyPlacementRound` with the learner's
 * yes/no answers to advance the state machine.
 */
export function nextPlacementRound(
  state: PlacementState,
  lexicon: Lexicon,
  config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
  rng: () => number = Math.random,
): PlacementRound | undefined {
  if (state.phase === 'done') return undefined;

  let levelIdx: number;
  if (state.phase === 'searching') {
    if (state.lo >= state.hi) return undefined; // converged; caller should have flipped to 'confirming'/'done'
    levelIdx = searchMid(state);
  } else {
    // confirming: alternate the level just below and the boundary level
    // itself, since that's where individual judgements matter most.
    const below = Math.max(0, state.lo - 1);
    levelIdx =
      state.confirmRoundsDone % 2 === 0 ? below : Math.min(LEVEL_ORDER.length - 1, state.lo);
  }

  const level = LEVEL_ORDER[Math.min(levelIdx, LEVEL_ORDER.length - 1)]!;
  const words = sampleLevel(level, lexicon, state.askedWordIds, config.sampleSize, rng);
  // No unseen words left at this level to sample — treat as "done enough".
  if (words.length === 0) return undefined;
  return { level, words };
}

/** Applies one round's yes/no answers (same order as `round.words`) and
 * returns the next state. */
export function applyPlacementRound(
  state: PlacementState,
  round: PlacementRound,
  answers: boolean[],
  config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): PlacementState {
  const judgements = [
    ...state.judgements,
    ...round.words.map((w, i) => ({
      wordId: w.id,
      level: round.level,
      known: answers[i] ?? false,
    })),
  ];
  const askedWordIds = new Set(state.askedWordIds);
  for (const w of round.words) askedWordIds.add(w.id);

  const knownFraction = answers.length > 0 ? answers.filter(Boolean).length / answers.length : 0;
  const levelIdx = LEVEL_ORDER.indexOf(round.level);

  if (state.phase === 'searching') {
    const { lo, hi } =
      knownFraction >= config.knownThreshold
        ? { lo: levelIdx + 1, hi: state.hi }
        : { lo: state.lo, hi: levelIdx };
    if (lo < hi) {
      return { ...state, lo, hi, judgements, askedWordIds };
    }
    // Converged: lo === hi === boundary index.
    return { ...state, lo, hi, phase: 'confirming', judgements, askedWordIds };
  }

  // confirming
  const confirmRoundsDone = state.confirmRoundsDone + 1;
  const phase: PlacementPhase = confirmRoundsDone >= config.confirmRounds ? 'done' : 'confirming';
  return { ...state, phase, confirmRoundsDone, judgements, askedWordIds };
}

export interface PlacementResult {
  /** First level the learner does NOT know well (levels before this are
   * considered known). Equals LEVEL_ORDER.length if everything was known. */
  boundaryLevelIndex: number;
  boundaryLevel: Level | null;
  judgements: PlacementJudgement[];
  /** Per-level known/total tap tallies, for the result summary screen. */
  byLevel: Partial<Record<Level, { known: number; total: number }>>;
}

export function summarizePlacement(state: PlacementState): PlacementResult {
  const byLevel: PlacementResult['byLevel'] = {};
  for (const j of state.judgements) {
    const entry = byLevel[j.level] ?? { known: 0, total: 0 };
    entry.total++;
    if (j.known) entry.known++;
    byLevel[j.level] = entry;
  }
  return {
    boundaryLevelIndex: state.lo,
    boundaryLevel: state.lo < LEVEL_ORDER.length ? LEVEL_ORDER[state.lo]! : null,
    judgements: state.judgements,
    byLevel,
  };
}
