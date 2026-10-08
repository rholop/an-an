import type { Level } from '../levels.config.js';

/** Phase 24: every number for graded stories lives here. */

export type StoryDifficulty = 'easier' | 'middle' | 'harder';

/** Part A shares. Rung 1 is a share of content-word tokens; rungs 3–6 count distinct words. */
export interface RungBudget {
  minRung1Share: number;
  /** Rung 1 share the prompt aims for. */
  targetRung1Share: number;
  maxRung3Words: number;
  maxRung4Words: number;
  maxRung5Words: number;
  /** Rung 6 words allowed when the story glosses them inline (an unglossed one always fails). */
  maxRung6Glossed: number;
}

export const STORY_BUDGETS: Record<StoryDifficulty, RungBudget> = {
  middle: { minRung1Share: 0.9, targetRung1Share: 0.95, maxRung3Words: 3, maxRung4Words: 1, maxRung5Words: 1, maxRung6Glossed: 1 },
  // Easier: rung 1 ≥ 97% and nothing from rung 4 up
  easier: { minRung1Share: 0.97, targetRung1Share: 0.98, maxRung3Words: 2, maxRung4Words: 0, maxRung5Words: 0, maxRung6Glossed: 0 },
  // Harder: rungs 3–5 may double
  harder: { minRung1Share: 0.85, targetRung1Share: 0.9, maxRung3Words: 6, maxRung4Words: 2, maxRung5Words: 2, maxRung6Glossed: 1 },
};

export const STORY_CONFIG = {
  /** Target length in characters, by level (Novice = N1/N2). */
  length: {
    N1: { min: 80, max: 150 },
    N2: { min: 80, max: 150 },
    L1: { min: 150, max: 300 },
    L2: { min: 250, max: 450 },
    L3: { min: 400, max: 700 },
    L4: { min: 400, max: 700 },
    L5: { min: 400, max: 700 },
  } satisfies Record<Level, { min: number; max: number }>,
  /** A story may be this much shorter / longer than the target and still be shown. */
  lengthSlack: 0.25,
  /** What the prompt receives: all rung 2–4 words, at most this many rung 1 words (due and recent first). */
  promptRung1Max: 300,
  promptRung5Max: 40,
  /** Each rung 2 word, ideally this many times. */
  rung2Repeats: { min: 2, max: 3 },
  /** Regenerations after the first attempt when the shares fail. */
  maxRegenerations: 1,
  questions: { min: 2, max: 4, optionsMin: 3, optionsMax: 4 },
  /** Stories kept ready in the background for the current lesson. */
  readyAhead: 2,
  /** "You'll find this one easier now": older than this, and this share of its words now learned. */
  reread: { minAgeDays: 14, minLearnedShare: 0.95, maxSuggestions: 3 },
  /** Characters read per minute at Novice, for "a 2-minute story". */
  charsPerMinute: 60,
} as const;
