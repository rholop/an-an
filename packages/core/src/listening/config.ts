/** Phase 15: every listening number in one place. */
export const LISTENING_CONFIG = {
  /** Exercises in a "Listen" session (10–15). */
  sessionSize: 12,
  /** Share of normal review/cloze sessions replaced by a listening exercise once an item has a listening card. */
  mixShare: 0.2,
  /** Correct after this many replays (or at slow speed) counts as Hard. */
  hardAfterReplays: 2,
  /** Listening-card stability (days) at which harder exercise types unlock: pick → tone check → type → sentence. */
  unlock: { hear_pick: 0, tone_check: 3, hear_type: 7, sentence_dictation: 14 },
  /** Sentence dictation at Novice levels stays this short. */
  noviceSentenceMaxChars: 12,
  /** Minimum minimal pairs shipped for tone pairs at N1–L1 (given verified clips). */
  minTonePairs: 30,
} as const;

export type ListeningConfig = typeof LISTENING_CONFIG;

export const EXERCISE_TYPES = [
  'hear_pick',
  'hear_type',
  'tone_check',
  'tone_pair',
  'sentence_dictation',
  'listen_understand',
] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];
