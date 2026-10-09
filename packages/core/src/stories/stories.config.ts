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
    // Phase 26: Novice stories are shorter (4–8 sentences, at most 3 paragraphs): easier to keep inside the lists.
    N1: { min: 60, max: 120 },
    N2: { min: 60, max: 120 },
    L1: { min: 150, max: 300 },
    L2: { min: 250, max: 450 },
    L3: { min: 400, max: 700 },
    L4: { min: 400, max: 700 },
    L5: { min: 400, max: 700 },
  } satisfies Record<Level, { min: number; max: number }>,
  /** A story may be this much shorter / longer than the target and still be shown. */
  lengthSlack: 0.25,
  /** Phase 25: shorter than the slack allows is still shown (after one regeneration) down to this share of the minimum. */
  minLengthShare: 0.4,
  /** Phase 26: what the prompt receives: all rung 2–4 words, at most this many rung 1 words (topic
   * matches first, then due), grouped with glosses; rung 5 only when it matches the topic. */
  promptRung1Max: 250,
  promptRung5Max: 20,
  /** Phase 26: at most this many rung 2 words, each used up to `max` times. */
  rung2Words: 3,
  rung2Repeats: { min: 1, max: 2 },
  /** Phase 26: Novice paragraphs / sentences. */
  novice: { paragraphsMax: 3, sentences: { min: 4, max: 8 } },
  /** Phase 26: model calls per story (first write + repairs or one rewrite), then 1 independent check. */
  maxWriteCalls: 3,
  /** Sentence-level repair rounds after the first write (within `maxWriteCalls`). */
  maxRepairRounds: 2,
  /** Background "ready ahead" pauses after this many failures in a row, for `pauseMs`. */
  readyAheadPause: { failures: 2, pauseMs: 60 * 60_000 },
  questions: { min: 2, max: 4, optionsMin: 3, optionsMax: 4 },
  /** Phase 26: lesson stories (`pnpm stories:build`): per lesson, and the attempts allowed per story. */
  lessonStories: { perLesson: 3, maxAttemptsPerStory: 6 },
  /** Phase 25/26: a story that misses only the word targets is still shown as a mini lesson (every
   * new word explained) when its known-or-this-lesson share is at least the floor and it has at most
   * this many new words. Only the floors refuse; the targets above drive the prompt. */
  miniLesson: {
    floor: { middle: 0.8, easier: 0.88, harder: 0.72 } satisfies Record<StoryDifficulty, number>,
    maxWords: { middle: 6, easier: 3, harder: 10 } satisfies Record<StoryDifficulty, number>,
  },
  /** Stories kept ready in the background for the current lesson. */
  readyAhead: 2,
  /** "You'll find this one easier now": older than this, and this share of its words now learned. */
  reread: { minAgeDays: 14, minLearnedShare: 0.95, maxSuggestions: 3 },
  /** Characters read per minute at Novice, for "a 2-minute story". */
  charsPerMinute: 60,
} as const;
