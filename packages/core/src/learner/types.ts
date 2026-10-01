import type { Card } from 'ts-fsrs';
import type { Evidence, ItemRef, ItemState, Skill } from '../types.js';

export type LeechTreatment =
  'new_context' | 'char_breakdown' | 'mnemonic_prompt' | 'contrast_confusable';

/** Phase 4 cloze difficulty ladder: 1 word bank, 2 multiple choice, 3 typed
 * from memory. See cloze/ladder.ts. */
export type ClozeRung = 1 | 2 | 3;

export const LEECH_TREATMENTS: readonly LeechTreatment[] = [
  'new_context',
  'char_breakdown',
  'mnemonic_prompt',
  'contrast_confusable',
];

/** Per item, per skill. See CLAUDE.md "Shared core types" / phase doc §"Data models". */
export interface SkillCard {
  item: ItemRef;
  skill: Skill;
  card: Card;
  state: ItemState;
  /** Mirrors card.lapses — kept top-level so storage layers (Dexie) can index
   * it without reaching into the nested FSRS card. */
  lapses: number;
  leech: boolean;
  leechTreatmentsTried: LeechTreatment[];
  /** Phase 4: cloze/ladder.ts's nextLadderState() output, persisted here so
   * the next session knows which exercise type to offer for this item. */
  clozeRung: ClozeRung;
  /** Consecutive no-hint-correct answers at the current rung — resets on
   * promotion, on a hint, and on a lapse. */
  clozeStreak: number;
  /** Weak-signal counter nudged by chat_read_no_lookup; see applyEvidence. */
  familiarity: number;
  /** 0 (reads characters, no pinyin dependence) .. 1 (always needs pinyin). */
  readingDependence: number;
  flags: {
    imported?: boolean;
    probablyKnown?: boolean;
    /** Phase 5 gap capture: a word the learner needed mid-sentence
     * (`[gym]`). Not-yet-reviewed cards with this flag jump the queue in
     * buildSession. */
    priority?: boolean;
  };
  updatedAt: Date;
}

export interface LearnerConfig {
  /** FSRS target retention, 0.85–0.90 per CLAUDE.md, user-configurable. */
  requestRetention: number;
  /** Stability (days) at/above which a card is considered "mature". */
  matureStabilityDays: number;
  /** Lapses at/above which a card is flagged a leech. */
  leechThreshold: number;
  /** chat_read_no_lookup requires this many occurrences (while due) before
   * it counts as a Good; below that it only nudges `familiarity`. */
  readNoLookupGoodThreshold: number;
  /** Per-event nudge size for familiarity / readingDependence (0..1 scale). */
  familiarityStep: number;
  readingDependenceStep: number;
  /** Conservative initial stability (days) for anki_import_seen. */
  importedInitialStability: number;
  /** Phase 5 §6: a journal_misuse the learner fixed themselves gets a milder
   * effect than a plain misuse — 'none' (just introduce/touch the card, no
   * FSRS rating) or 'hard' (same as an unaided misuse). */
  selfFixedMisuseEffect: 'none' | 'hard';
}

export const DEFAULT_LEARNER_CONFIG: LearnerConfig = {
  requestRetention: 0.9,
  matureStabilityDays: 21,
  leechThreshold: 4,
  readNoLookupGoodThreshold: 2,
  familiarityStep: 0.25,
  readingDependenceStep: 0.15,
  importedInitialStability: 3,
  selfFixedMisuseEffect: 'none',
};

/** Result of applying one piece of evidence to one (possibly nonexistent)
 * SkillCard. `card` is undefined only when the evidence was a no-op (e.g. a
 * weak signal on an item that has never been introduced — see applyEvidence). */
export interface ModelUpdate {
  card: SkillCard | undefined;
  /** Short machine-readable tag for tests/debugging, e.g. "fsrs:good",
   * "familiarity:+1", "ignored:unseen-weak-signal". */
  appliedEffect: string;
}

export interface LearnerRepo {
  getCard(item: ItemRef, skill: Skill): Promise<SkillCard | undefined>;
  putCards(cards: SkillCard[]): Promise<void>;
  appendEvidence(e: Evidence[]): Promise<void>;
  dueCards(now: Date, limit: number): Promise<SkillCard[]>;
  knownSet(minState: ItemState): Promise<Set<string>>;
}
