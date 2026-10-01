import { Rating, State, type Card, type FSRS, type Grade } from 'ts-fsrs';
import { nextLadderState, type ClozeOutcome } from '../cloze/ladder.js';
import type { Evidence } from '../types.js';
import { buildFsrs, computeItemState, emptyCard } from './fsrs-instance.js';
import {
  DEFAULT_LEARNER_CONFIG,
  type LearnerConfig,
  type ModelUpdate,
  type SkillCard,
} from './types.js';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function blankSkillCard(evidence: Evidence, card: Card, now: Date): SkillCard {
  return {
    item: evidence.item,
    skill: evidence.skill,
    card,
    state: 'unseen',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}

function withCard(base: SkillCard, card: Card, now: Date, config: LearnerConfig): SkillCard {
  return {
    ...base,
    card,
    state: computeItemState(card, config),
    lapses: card.lapses,
    leech: card.lapses >= config.leechThreshold,
    updatedAt: now,
  };
}

/** The one place a rating (Again/Hard/Good/Easy) is turned into a new FSRS
 * card. Used by every "real review" evidence kind. */
function applyFsrsRating(
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  grade: Grade,
  config: LearnerConfig,
  fsrsInstance: FSRS,
): ModelUpdate {
  const base = current ?? blankSkillCard(evidence, emptyCard(now), now);
  const { card } = fsrsInstance.next(base.card, now, grade);
  return {
    card: withCard(base, card, now, config),
    appliedEffect: `fsrs:${Rating[grade].toLowerCase()}`,
  };
}

/** cloze_correct_nohint/cloze_correct_hint/cloze_wrong: an FSRS rating (same
 * as a real review) PLUS the Phase 4 difficulty-ladder transition
 * (cloze/ladder.ts), kept together so a cloze answer always updates both in
 * one step. `current` may be a brand-new card (applyFsrsRating handles the
 * introduce-via-blankSkillCard case), in which case the ladder starts fresh
 * from rung 1 — matching a cloze exercise always being offered on an
 * already-introduced item in practice, but safe either way. */
function applyClozeAnswer(
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  config: LearnerConfig,
  fsrsInstance: FSRS,
  outcome: ClozeOutcome,
  grade: Grade,
): ModelUpdate {
  const rated = applyFsrsRating(current, evidence, now, grade, config, fsrsInstance);
  if (!rated.card) return rated;
  const ladder = nextLadderState(
    { rung: current?.clozeRung ?? 1, streak: current?.clozeStreak ?? 0 },
    outcome,
  );
  return {
    card: { ...rated.card, clozeRung: ladder.rung, clozeStreak: ladder.streak },
    appliedEffect: `${rated.appliedEffect} + ladder:rung${ladder.rung}(streak ${ladder.streak})`,
  };
}

/** journal_misuse: Hard on the production card — unless the learner fixed it
 * themselves and config says that earns a milder effect, in which case the
 * card is only introduced/touched (no FSRS rating consumed). */
function applyJournalMisuse(
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  config: LearnerConfig,
  fsrsInstance: FSRS,
): ModelUpdate {
  if (!evidence.context?.selfFixed || config.selfFixedMisuseEffect === 'hard') {
    return applyFsrsRating(current, evidence, now, Rating.Hard, config, fsrsInstance);
  }
  if (current)
    return { card: { ...current, updatedAt: now }, appliedEffect: 'ignored:self-fixed-misuse' };
  const base = blankSkillCard(evidence, emptyCard(now), now);
  return { card: { ...base, state: 'introduced' }, appliedEffect: 'introduce (self-fixed misuse)' };
}

/** chat_read_no_lookup: weak positive. Never schedules a full FSRS review on
 * its own — only after `readNoLookupGoodThreshold` occurrences AND the card
 * being due does it finally count as a Good. No-ops on an item that was
 * never introduced (nothing to nudge). */
function applyReadNoLookup(
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  config: LearnerConfig,
  fsrsInstance: FSRS,
): ModelUpdate {
  if (!current) return { card: undefined, appliedEffect: 'ignored:unseen-weak-signal' };

  const isDue = current.card.due <= now;
  const nextFamiliarity = current.familiarity + 1;

  if (isDue && nextFamiliarity >= config.readNoLookupGoodThreshold) {
    const { card } = fsrsInstance.next(current.card, now, Rating.Good);
    return {
      card: { ...withCard(current, card, now, config), familiarity: 0 },
      appliedEffect: 'fsrs:good (via chat_read_no_lookup threshold)',
    };
  }

  return {
    card: { ...current, familiarity: nextFamiliarity, updatedAt: now },
    appliedEffect: `familiarity:+1 (${nextFamiliarity}/${config.readNoLookupGoodThreshold})`,
  };
}

/** chat_lookup_gloss: Again on recognition if the card is already in review
 * (they forgot something they'd learned); otherwise just introduce it —
 * instantiate the SkillCard with no FSRS rating consumed yet. Callers are
 * expected to emit this with skill: 'recognition' (CLAUDE.md evidence
 * table) — applyEvidence trusts evidence.skill rather than hardcoding it. */
function applyLookupGloss(
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  config: LearnerConfig,
  fsrsInstance: FSRS,
): ModelUpdate {
  if (current && (current.state === 'review' || current.state === 'mature')) {
    const { card } = fsrsInstance.next(current.card, now, Rating.Again);
    return {
      card: withCard(current, card, now, config),
      appliedEffect: 'fsrs:again (lookup after review)',
    };
  }
  if (current)
    return { card: { ...current, updatedAt: now }, appliedEffect: 'ignored:already-introduced' };
  const base = blankSkillCard(evidence, emptyCard(now), now);
  return { card: { ...base, state: 'introduced' }, appliedEffect: 'introduce' };
}

/** chat_hover_reading: never touches meaning/FSRS; only nudges
 * readingDependence, used by readingDisplay() for pinyin fading. No-ops on
 * an item that hasn't been introduced yet. */
function applyHoverReading(
  current: SkillCard | undefined,
  now: Date,
  config: LearnerConfig,
): ModelUpdate {
  if (!current) return { card: undefined, appliedEffect: 'ignored:unseen-weak-signal' };
  const readingDependence = clamp01(current.readingDependence + config.readingDependenceStep);
  return {
    card: { ...current, readingDependence, updatedAt: now },
    appliedEffect: `readingDependence:+${config.readingDependenceStep}`,
  };
}

function applyAnkiImportSeen(evidence: Evidence, now: Date, config: LearnerConfig): ModelUpdate {
  const card: Card = {
    ...emptyCard(now),
    state: State.Review,
    stability: config.importedInitialStability,
    difficulty: 5,
    scheduled_days: config.importedInitialStability,
    reps: 1,
    due: new Date(now.getTime() + config.importedInitialStability * 86_400_000),
    last_review: now,
  };
  const base = blankSkillCard(evidence, card, now);
  return {
    card: { ...base, state: computeItemState(card, config), flags: { imported: true } },
    appliedEffect: 'init:imported-review',
  };
}

function applyPlacement(
  evidence: Evidence,
  now: Date,
  config: LearnerConfig,
  known: boolean,
): ModelUpdate {
  if (!known) {
    const base = blankSkillCard(evidence, emptyCard(now), now);
    return { card: { ...base, state: 'unseen' }, appliedEffect: 'init:placement-unknown' };
  }
  const stability = config.importedInitialStability / 2;
  const card: Card = {
    ...emptyCard(now),
    state: State.Review,
    stability,
    difficulty: 5,
    scheduled_days: stability,
    reps: 1,
    due: new Date(now.getTime() + stability * 86_400_000),
    last_review: now,
  };
  const base = blankSkillCard(evidence, card, now);
  return {
    card: { ...base, state: computeItemState(card, config), flags: { probablyKnown: true } },
    appliedEffect: 'init:placement-known',
  };
}

export type EvidenceHandler = (
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  config: LearnerConfig,
  fsrsInstance: FSRS,
) => ModelUpdate;

/**
 * Evidence -> effect, kept as data (one row per CLAUDE.md phase-2 table)
 * rather than scattered if/else, per the phase doc's explicit requirement.
 */
export const EVIDENCE_HANDLERS: Record<Evidence['kind'], EvidenceHandler> = {
  review_again: (c, e, n, cfg, f) => applyFsrsRating(c, e, n, Rating.Again, cfg, f),
  review_hard: (c, e, n, cfg, f) => applyFsrsRating(c, e, n, Rating.Hard, cfg, f),
  review_good: (c, e, n, cfg, f) => applyFsrsRating(c, e, n, Rating.Good, cfg, f),
  review_easy: (c, e, n, cfg, f) => applyFsrsRating(c, e, n, Rating.Easy, cfg, f),

  cloze_correct_nohint: (c, e, n, cfg, f) =>
    applyClozeAnswer(c, e, n, cfg, f, 'correct', Rating.Good),
  cloze_correct_hint: (c, e, n, cfg, f) =>
    applyClozeAnswer(c, e, n, cfg, f, 'correct_wrong_tone', Rating.Hard),
  cloze_wrong: (c, e, n, cfg, f) => applyClozeAnswer(c, e, n, cfg, f, 'wrong', Rating.Again),

  journal_correct_use: (c, e, n, cfg, f) => applyFsrsRating(c, e, n, Rating.Good, cfg, f),
  journal_misuse: applyJournalMisuse,

  chat_read_no_lookup: (c, e, n, cfg, f) => applyReadNoLookup(c, e, n, cfg, f),
  chat_lookup_gloss: (c, e, n, cfg, f) => applyLookupGloss(c, e, n, cfg, f),
  chat_hover_reading: (c, _e, n, cfg) => applyHoverReading(c, n, cfg),

  anki_import_seen: (_c, e, n, cfg) => applyAnkiImportSeen(e, n, cfg),
  placement_known: (_c, e, n, cfg) => applyPlacement(e, n, cfg, true),
  placement_unknown: (_c, e, n, cfg) => applyPlacement(e, n, cfg, false),
};

/**
 * The only function allowed to change a learner's model (phase doc §1).
 * Pure: no I/O, no Date.now() — `now` is always injected. Persistence
 * (fetching `current`, writing the result, appending the evidence log) is
 * the caller's job (apps/web's LearnerRepo).
 */
export function applyEvidence(
  current: SkillCard | undefined,
  evidence: Evidence,
  now: Date,
  config: LearnerConfig = DEFAULT_LEARNER_CONFIG,
  fsrsInstance: FSRS = buildFsrs(config),
): ModelUpdate {
  return EVIDENCE_HANDLERS[evidence.kind](current, evidence, now, config, fsrsInstance);
}
