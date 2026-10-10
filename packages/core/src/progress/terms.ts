// Phase 21 Part B: the ONLY place that decides what New, Due, Learned and Mastered mean,
// which items make up a lesson or a level, and which words count as comprehensible.
// Every tab, count and validator imports from here (an architecture test enforces it).
// Pure functions; time is always injected.

import type { SkillCard } from '../learner/types.js';
import type { Level } from '../levels.config.js';
import type { Lesson } from '../textbook/types.js';
import { State, type Card, type FSRS } from 'ts-fsrs';
import type { Evidence, ItemRef, ItemState, Skill, Word } from '../types.js';
import { PROGRESS_CONFIG, type ProgressConfig } from './progress.config.js';
import { DEFAULT_SESSION_SETTINGS, zonedDay } from './review-sessions.js';

export const itemKeyOf = (i: ItemRef): string => `${i.kind}:${i.id}`;

/** Phase 29 Part B.9: an FSRS card's game state (introduced → learning → review → mature). The
 * scheduler stores it on every answer; `mature` is decided here, from `PROGRESS_CONFIG`. There is
 * no FSRS state for "unseen": that is the absence of a card. */
export function itemStateOf(card: Pick<Card, 'state' | 'stability'>, cfg: Pick<ProgressConfig, 'matureStabilityDays'> = PROGRESS_CONFIG): ItemState {
  switch (card.state) {
    case State.Learning:
    case State.Relearning:
      return 'learning';
    case State.Review:
      return card.stability >= cfg.matureStabilityDays ? 'mature' : 'review';
    default:
      return 'introduced';
  }
}

// ---------------------------------------------------------------------------------------------
// Card-level terms

/** Phase 20: a card still in review (not removed by Nope "Not now" / "Never show"). */
export function isActiveCard(c: Pick<SkillCard, 'flags'>): boolean {
  return !c.flags.excluded && !c.flags.snoozed;
}

/** Anki import / placement test seeds: the card starts in review without a real answer. */
export function isSeeded(c: Pick<SkillCard, 'flags'>): boolean {
  return !!(c.flags.imported || c.flags.probablyKnown);
}

/** Answers given in this app (a seed's own "rep" doesn't count). */
export function inAppAnswers(c: Pick<SkillCard, 'card' | 'flags'>): number {
  return Math.max(0, c.card.reps - (isSeeded(c) ? 1 : 0));
}

/** The learner said they know it: the quick check, or Nope "I know this". */
export function saidKnown(c: Pick<SkillCard, 'flags'>): boolean {
  return !!(c.flags.knownChecked || c.flags.markedKnown);
}

/** The card is past its first answers: FSRS Review state ('review' or 'mature'). */
export function isInReview(c: Pick<SkillCard, 'state'>): boolean {
  return c.state === 'review' || c.state === 'mature';
}



/** **New**: a card that exists but was never answered (it waits to be met). */
export function isNewCard(c: Pick<SkillCard, 'state' | 'card'>): boolean {
  return c.state === 'introduced' && c.card.reps === 0;
}

/** **Due**: answered at least once, due now, and not removed by Nope. `unseen` cards are never due. */
export function isDueCard(c: Pick<SkillCard, 'state' | 'card' | 'flags'>, now: Date): boolean {
  return c.state !== 'unseen' && c.card.reps > 0 && c.card.due.getTime() <= now.getTime() && isActiveCard(c);
}

/** Days an answered card was overdue at `at` (0 for a New or unseen card, or one not yet due). */
export function overdueDaysAt(c: Pick<SkillCard, 'state' | 'card'> | undefined, at: Date): number {
  if (!c || c.state === 'unseen' || c.state === 'introduced') return 0;
  return Math.max(0, (at.getTime() - new Date(c.card.due).getTime()) / 86_400_000);
}

/** Answered at least once and not removed by Nope: the card takes part in review sessions. */
export function isScheduledCard(c: Pick<SkillCard, 'state' | 'card' | 'flags'>): boolean {
  return c.state !== 'unseen' && c.card.reps > 0 && isActiveCard(c);
}

/** FSRS R(t) in [0,1], or null for a card never answered (a seed has no memory to decay yet, so it
 * can't wilt). */
export function retrievabilityOf(card: SkillCard, now: Date, fsrsInstance: FSRS): number | null {
  if (card.card.state === State.New || card.card.reps === 0) return null;
  return fsrsInstance.get_retrievability(card.card, now, false);
}

/** The scheduler's own clock: FSRS has this card due at `now` (only the scheduler reads it; every
 * screen uses the review session instead). */
export function fsrsDue(c: Pick<SkillCard, 'card'>, now: Date): boolean {
  return new Date(c.card.due).getTime() <= now.getTime();
}

/** Phase 23 **Due** in a session: scheduled, and due before the session's cutoff (the morning session
 * holds everything due before the evening opens; see `progress/review-sessions.ts`). */
export function isDueBefore(c: Pick<SkillCard, 'state' | 'card' | 'flags'>, cutoff: Date): boolean {
  return isScheduledCard(c) && c.card.due.getTime() < cutoff.getTime();
}

/** **Learned** (one card): in review after an answer in this app, or the learner said they know it. */
export function isLearnedCard(c: Pick<SkillCard, 'state' | 'card' | 'flags'>): boolean {
  if (!isInReview(c)) return false;
  return inAppAnswers(c) > 0 || saidKnown(c);
}

/** Seeds from Anki / placement that haven't had an in-app answer yet: shown as "Imported". */
export function isImportedOnly(c: Pick<SkillCard, 'state' | 'card' | 'flags'>): boolean {
  return isSeeded(c) && inAppAnswers(c) === 0 && !saidKnown(c);
}

/** Card has had at least one real answer (seeds count: they enter as reviewed). */
export function isAnswered(c: Pick<SkillCard, 'card'>): boolean {
  return c.card.reps > 0;
}

/** Listening "practised": answered at least once (auto-created cards with no answer don't count). */
export const isPractisedListening = (c: Pick<SkillCard, 'card'>): boolean => c.card.reps > 0;

/** Listening extras in a session: practised listening cards that are due now (their own queue). */
export const isDueListening = (c: Pick<SkillCard, 'card'>, now: Date): boolean =>
  c.card.reps > 0 && c.card.due.getTime() <= now.getTime();

/** Listening "strong". */
export const isStrongListening = (c: Pick<SkillCard, 'card'>, cfg: ProgressConfig = PROGRESS_CONFIG): boolean =>
  c.card.reps > 0 && c.card.stability >= cfg.listeningStrongDays;

/** Phase 23: a production card with no ladder state starts at Recall once it is in review and this
 * stable (`PROGRESS_CONFIG.recallStabilityDays`); otherwise at Pick. */
export function startsAtRecall(c: Pick<SkillCard, 'state' | 'card'>, cfg: Pick<ProgressConfig, 'recallStabilityDays'> = PROGRESS_CONFIG): boolean {
  return isInReview(c) && c.card.stability >= cfg.recallStabilityDays;
}

/** Pinyin fading: strong enough, and the learner isn't leaning on the reading. */
export function readingMayFade(
  c: Pick<SkillCard, 'card' | 'readingDependence'>,
  cfg: { readingFadeStabilityDays: number; readingFadeMaxDependence: number } = PROGRESS_CONFIG,
): boolean {
  return c.card.stability >= cfg.readingFadeStabilityDays && c.readingDependence < cfg.readingFadeMaxDependence;
}

/** Listening (Phase 15) and reading (Phase 23) are practice skills: scheduled like the others, but
 * never part of Learned, Mastered, lesson mastery or comprehension. */
export const isPracticeSkill = (s: Skill): boolean => s === 'listening' || s === 'reading';
/** Phase 23: skills Review shows (Meaning, Pick / Recall, Say it). Listening has its own tab only. */
export const isReviewSkill = (s: Skill): boolean => s !== 'listening';

/** Recognition card reached learning (answered in this app, not New; imports wait for an answer):
 * unlocks its reading card (Phase 23). */
export const unlocksReading = (c: Pick<SkillCard, 'state' | 'card' | 'flags' | 'skill' | 'item'>): boolean =>
  c.skill === 'recognition' &&
  c.item.kind === 'word' &&
  c.state !== 'unseen' &&
  c.state !== 'introduced' &&
  (inAppAnswers(c) > 0 || saidKnown(c)) &&
  isActiveCard(c);

/** The evidence that creates a word's reading card once its recognition card is learning. */
export function readingUnlockFor(updated: SkillCard, hasReading: boolean, at: Date): Evidence | undefined {
  if (hasReading || !unlocksReading(updated)) return undefined;
  return { item: updated.item, skill: 'reading', kind: 'reading_unlocked', at, context: { source: 'review' } };
}

/** Recognition card Learned: unlocks its listening card (Phase 15, with a clip). */
export const unlocksListening = (c: Pick<SkillCard, 'state' | 'card' | 'flags' | 'skill' | 'item'>): boolean =>
  c.skill === 'recognition' && c.item.kind === 'word' && isLearnedCard(c);

/** Recognition card Learned: unlocks its production card (Part B rule 1). */
export const unlocksProduction = (c: Pick<SkillCard, 'state' | 'card' | 'flags' | 'skill' | 'item'>): boolean =>
  c.skill === 'recognition' && c.item.kind === 'word' && isLearnedCard(c);

/** The evidence that creates a word's production card once its recognition card is Learned
 * (Part B rule 1). Undefined when there is nothing to unlock. */
export function productionUnlockFor(updated: SkillCard, hasProduction: boolean, at: Date): Evidence | undefined {
  if (hasProduction || !unlocksProduction(updated) || !isActiveCard(updated)) return undefined;
  return {
    item: updated.item,
    skill: 'production',
    kind: 'production_unlocked',
    at,
    context: { source: 'review' },
  };
}

// ---------------------------------------------------------------------------------------------
// Item sets: one lesson set, one level set

type LessonLists = Pick<Lesson, 'vocab' | 'grammarWords' | 'properNouns' | 'grammar'> &
  Partial<Pick<Lesson, 'supplementary' | 'extra'>>;

/** Phase 34: a lesson's extra word ids: 補充生詞 and the words found on its other pages, minus its core words and names. */
export function lessonExtraWordIds(lesson: LessonLists): string[] {
  const skip = new Set([...lesson.properNouns, ...lesson.vocab, ...(lesson.grammarWords ?? [])]);
  return [...new Set([...(lesson.supplementary ?? []), ...(lesson.extra ?? [])])].filter((id) => !skip.has(id));
}

/**
 * A lesson's core items: vocab + grammar words − proper nouns, then its grammar points (de-duplicated).
 * This is what the lesson's Mastered share counts. Phase 34: `withExtras` adds the extra words
 * (only when `PRIORITY_CONFIG.extrasCountForLessonMastery` is on; the default leaves them out).
 */
export function lessonCoreItems(lesson: LessonLists, opts: { withExtras?: boolean } = {}): ItemRef[] {
  const proper = new Set(lesson.properNouns);
  const words = [...new Set([...lesson.vocab, ...(lesson.grammarWords ?? [])])].filter((id) => !proper.has(id));
  return [
    ...words.map((id) => ({ kind: 'word' as const, id })),
    ...[...new Set(lesson.grammar)].map((id) => ({ kind: 'grammar' as const, id })),
    ...(opts.withExtras ? lessonExtraWordIds(lesson).map((id) => ({ kind: 'word' as const, id })) : []),
  ];
}

/** Phase 34: what a lesson TEACHES: its core items, then its extra words (when taught). */
export function lessonTaughtItems(lesson: LessonLists, teachExtras: boolean): ItemRef[] {
  const core = lessonCoreItems(lesson);
  return teachExtras ? [...core, ...lessonExtraWordIds(lesson).map((id) => ({ kind: 'word' as const, id }))] : core;
}

/** Word ids of `lessonCoreItems`. */
export function lessonCoreWordIds(lesson: LessonLists): string[] {
  return lessonCoreItems(lesson)
    .filter((i) => i.kind === 'word')
    .map((i) => i.id);
}

/** A TOCFL level's items: the words of the official list at that level. */
export function levelItems(level: Level, words: readonly Pick<Word, 'id' | 'source' | 'level'>[]): ItemRef[] {
  return words.filter((w) => w.source === 'tocfl' && w.level === level).map((w) => ({ kind: 'word' as const, id: w.id }));
}

// ---------------------------------------------------------------------------------------------
// Item-level terms

export interface GrammarUse {
  correct: number;
  lastCorrect: boolean;
  /** Phase 25: the profile-zone days (YYYY-MM-DD) of the first and the latest correct use. */
  firstCorrectDay?: string;
  lastCorrectDay?: string;
}

/**
 * Phase 25: the correct uses that count toward Mastered (the progress dots, 0–3). The last one only
 * counts on a later day than the first, so mastery means remembering, not cramming one sitting.
 */
export function grammarDots(
  u: GrammarUse | undefined,
  cfg: Pick<ProgressConfig, 'mastered'> = PROGRESS_CONFIG,
): number {
  if (!u) return 0;
  const need = cfg.mastered.grammarCorrectUses;
  const laterDay = !!u.firstCorrectDay && !!u.lastCorrectDay && u.lastCorrectDay > u.firstCorrectDay;
  return Math.min(u.correct, laterDay ? need : need - 1);
}

/** Correct-use tallies per grammar point from the evidence log (cloze, journal, review). Days are
 * counted in `timeZone` (the profile's review time zone). */
export function grammarUsesFromEvidence(
  evidence: readonly Pick<Evidence, 'item' | 'kind' | 'at'>[],
  cfg: Pick<ProgressConfig, 'grammarCorrectKinds' | 'grammarWrongKinds'> = PROGRESS_CONFIG,
  timeZone: string = DEFAULT_SESSION_SETTINGS.timeZone,
): Map<string, GrammarUse> {
  const ok = new Set<string>(cfg.grammarCorrectKinds);
  const bad = new Set<string>(cfg.grammarWrongKinds);
  const sorted = evidence
    .filter((e) => e.item.kind === 'grammar' && (ok.has(e.kind) || bad.has(e.kind)))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const out = new Map<string, GrammarUse>();
  for (const e of sorted) {
    const cur = out.get(e.item.id) ?? { correct: 0, lastCorrect: false };
    const correct = ok.has(e.kind);
    if (!correct) {
      out.set(e.item.id, { ...cur, lastCorrect: false });
      continue;
    }
    const day = zonedDay(e.at, timeZone);
    out.set(e.item.id, {
      correct: cur.correct + 1,
      lastCorrect: true,
      firstCorrectDay: cur.firstCorrectDay ?? day,
      lastCorrectDay: day,
    });
  }
  return out;
}

/** Phase 25: what to tell the learner about a point after practice (`today` = the profile-zone day). */
export function grammarOutcome(
  u: GrammarUse | undefined,
  today: string,
  cfg: Pick<ProgressConfig, 'mastered'> = PROGRESS_CONFIG,
): 'mastered' | 'tomorrow' | 'more' {
  const need = cfg.mastered.grammarCorrectUses;
  if (u?.lastCorrect && grammarDots(u, cfg) >= need) return 'mastered';
  // Enough right answers, but all since today: only a later day can finish it.
  if (u?.lastCorrect && u.correct >= need - 1 && u.firstCorrectDay === today) return 'tomorrow';
  return 'more';
}

export interface ProgressIndexInputs {
  /** Every card (any skill). Listening cards are ignored here. */
  cards: readonly SkillCard[];
  grammarUses?: ReadonlyMap<string, GrammarUse>;
  /** Legacy (Phase 14) "already known" list: "word:id" / "grammar:id". */
  knownItems?: readonly string[];
  config?: ProgressConfig;
}

export interface LearnedMastered {
  total: number;
  learned: number;
  mastered: number;
  /** 1 for an empty set. */
  learnedShare: number;
  masteredShare: number;
  /** Items not yet mastered. */
  remainingWords: number;
  remainingGrammar: number;
  /** Learned but stuck (leech): never mastered. */
  leeches: number;
  /** Seeds from Anki / placement with no answer in this app yet. */
  imported: number;
}

export type ItemProgress = 'new' | 'imported' | 'learning' | 'learned' | 'mastered';

/** Everything a screen needs to say New / Due / Learned / Mastered about items, built once. */
export class ProgressIndex {
  private readonly bySkill = new Map<string, SkillCard>();
  private readonly known: Set<string>;
  readonly cfg: ProgressConfig;
  private readonly grammarUses: ReadonlyMap<string, GrammarUse>;

  constructor(inputs: ProgressIndexInputs) {
    for (const c of inputs.cards) {
      if (isPracticeSkill(c.skill)) continue;
      this.bySkill.set(`${itemKeyOf(c.item)}|${c.skill}`, c);
    }
    this.known = new Set(inputs.knownItems ?? []);
    this.cfg = inputs.config ?? PROGRESS_CONFIG;
    this.grammarUses = inputs.grammarUses ?? new Map();
  }

  /**
   * Phase 25: a grammar point's correct-use tally (the progress dots). Phase 29 Part B.8: the quick
   * check and the legacy "already known" list count as a full tally, so ●●● and Mastered always agree
   * (a later wrong use still resets "last correct", as for any tally).
   */
  grammarUse(id: string): GrammarUse | undefined {
    const u = this.grammarUses.get(id);
    const ref: ItemRef = { kind: 'grammar', id };
    const vouched = this.legacyKnown(ref) || this.checkedKnown(this.card(ref, 'recognition'));
    if (!vouched || (u && !u.lastCorrect)) return u;
    const need = this.cfg.mastered.grammarCorrectUses;
    if (u && grammarDots(u, this.cfg) >= need) return u;
    return { correct: need, lastCorrect: true, firstCorrectDay: '0000-01-01', lastCorrectDay: '0000-01-02' };
  }

  card(i: ItemRef, skill: 'recognition' | 'production'): SkillCard | undefined {
    return this.bySkill.get(`${itemKeyOf(i)}|${skill}`);
  }

  private cardsOf(i: ItemRef): SkillCard[] {
    return [this.card(i, 'recognition'), this.card(i, 'production')].filter((c): c is SkillCard => !!c);
  }

  hasCard(i: ItemRef): boolean {
    return this.cardsOf(i).some((c) => c.state !== 'unseen');
  }

  /** Phase 20: "Not now" / "Never show" items leave lesson and level counts. */
  removed(i: ItemRef): boolean {
    return this.cardsOf(i).some((c) => c.flags.excluded || c.flags.snoozed);
  }

  leech(i: ItemRef): boolean {
    return this.cardsOf(i).some((c) => c.leech);
  }

  /** The legacy "already known" list, unless a lapse since says otherwise. */
  private legacyKnown(i: ItemRef): boolean {
    if (!this.known.has(itemKeyOf(i))) return false;
    if (i.kind === 'grammar') {
      const u = this.grammarUses.get(i.id);
      return !(u && !u.lastCorrect);
    }
    const r = this.card(i, 'recognition');
    return !(r && r.lapses > 0 && r.card.stability < this.cfg.knownContradictedStabilityDays);
  }

  /** The quick check passed and nothing has contradicted it since (no lapse after it). */
  private checkedKnown(c: SkillCard | undefined): boolean {
    return !!c?.flags.knownChecked && c.lapses <= (c.flags.knownCheckLapses ?? 0) && isInReview(c);
  }

  /** **Imported**: seeded by Anki / placement, no answer here yet. */
  imported(i: ItemRef): boolean {
    const r = this.card(i, 'recognition');
    return !!r && isImportedOnly(r) && !this.legacyKnown(i);
  }

  /** **Learned**: recognition in review after an answer in this app, or passed "I already know this".
   * Grammar: at least one correct use (or the check). Leeches count as Learned. */
  learned(i: ItemRef): boolean {
    if (this.legacyKnown(i)) return true;
    if (i.kind === 'grammar') {
      const u = this.grammarUse(i.id);
      if (u && u.correct > 0) return true;
      const r = this.card(i, 'recognition');
      return !!r && isLearnedCard(r);
    }
    const r = this.card(i, 'recognition');
    return !!r && isLearnedCard(r);
  }

  /** **Mastered**: recognition ≥ 21 d and production ≥ 7 d, not a leech; or passed the check and not
   * contradicted since. Grammar: 3 correct uses (the dots), the last one correct and on a later day
   * than the first (Phase 25), never a leech (Phase 29). */
  mastered(i: ItemRef): boolean {
    if (i.kind === 'grammar') {
      // Phase 29 Part B.8: the dots ARE the rule (●●● ⇔ Mastered), and a leech is never Mastered.
      if (this.leech(i)) return false;
      const u = this.grammarUse(i.id);
      return !!u && u.lastCorrect && grammarDots(u, this.cfg) >= this.cfg.mastered.grammarCorrectUses;
    }
    const r = this.card(i, 'recognition');
    const pr = this.card(i, 'production');
    if (r?.leech || pr?.leech) return false;
    // Phase 20 Nope "I know this" counts only once a later review has passed.
    const unproven = (c: SkillCard | undefined) =>
      !!c?.flags.markedKnown &&
      !(c.card.last_review && c.flags.markedKnownAt && new Date(c.card.last_review) > new Date(c.flags.markedKnownAt));
    if (unproven(r) || unproven(pr)) return false;
    if (this.checkedKnown(r) && (!pr || this.checkedKnown(pr) || isInReview(pr))) return true;
    if (
      r &&
      pr &&
      r.card.stability >= this.cfg.mastered.recognitionStabilityDays &&
      pr.card.stability >= this.cfg.mastered.productionStabilityDays
    )
      return true;
    return this.legacyKnown(i);
  }

  status(i: ItemRef): ItemProgress {
    if (this.mastered(i)) return 'mastered';
    if (this.learned(i)) return 'learned';
    if (this.imported(i)) return 'imported';
    const cards = this.cardsOf(i).filter((c) => c.state !== 'unseen');
    if (cards.length === 0 || cards.every((c) => isNewCard(c))) return 'new';
    return 'learning';
  }

  summarize(items: readonly ItemRef[]): LearnedMastered {
    let learned = 0;
    let mastered = 0;
    let leeches = 0;
    let imported = 0;
    let remainingWords = 0;
    let remainingGrammar = 0;
    for (const i of items) {
      const m = this.mastered(i);
      if (m) mastered++;
      else if (i.kind === 'word') remainingWords++;
      else remainingGrammar++;
      if (m || this.learned(i)) learned++;
      else if (this.imported(i)) imported++;
      if (this.leech(i)) leeches++;
    }
    const total = items.length;
    return {
      total,
      learned,
      mastered,
      learnedShare: total === 0 ? 1 : learned / total,
      masteredShare: total === 0 ? 1 : mastered / total,
      remainingWords,
      remainingGrammar,
      leeches,
      imported,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Comprehensible

/** Token classes a reader is expected to understand (chat validator, open chat, cloze, reader, coverage). */
export const COMPREHENSIBLE_CLASSES: ReadonlySet<string> = new Set(['known', 'due', 'learning', 'allowed']);

/** Word tags that are always fine to show (names, NPC names, particles, fillers). */
export const ALWAYS_ALLOWED_TAGS: ReadonlySet<string> = new Set(['name', 'npc', 'particle', 'filler']);

/** A word that is always fine to show (one of `ALWAYS_ALLOWED_TAGS`): never counted against a tier. */
export const isAlwaysAllowedWord = (tags: readonly string[]): boolean => tags.some((t) => ALWAYS_ALLOWED_TAGS.has(t));

export interface WordSets {
  /** Learned (or mastered). */
  knownIds: Set<string>;
  /** Due cards' words (answered at least once, due now). */
  dueIds: Set<string>;
  /** Words being learned: answered but not (yet) Learned, imported seeds, production-only cards. */
  learningIds: Set<string>;
  /** Words met but never answered (New): not comprehensible on their own. */
  newIds: Set<string>;
}

// ---------------------------------------------------------------------------------------------
// Phase 29 Part C.2: the last readings of scheduling fields that lived outside core/progress.

const DAY_MS = 86_400_000;

/** Days since the last review relative to the card's stability: higher = more likely forgotten
 * (the session cap keeps the most likely forgotten first). */
export function forgetRiskOf(c: Pick<SkillCard, 'card'>, now: Date): number {
  const last = c.card.last_review ? new Date(c.card.last_review).getTime() : new Date(c.card.due).getTime();
  const elapsed = Math.max(0, (now.getTime() - last) / DAY_MS);
  return elapsed / Math.max(c.card.stability, 0.1);
}

/** The profile-zone day a card is next due ("YYYY-MM-DD"), for the review pile report. */
export function dueDayOf(c: Pick<SkillCard, 'card'>, timeZone: string = DEFAULT_SESSION_SETTINGS.timeZone): string {
  return zonedDay(new Date(c.card.due), timeZone);
}

/** How well a practice card (listening) is known, in stability days: picks its exercise types
 * (a difficulty ladder, never a progress number). 0 without a card. */
export function practiceStrengthOf(c: Pick<SkillCard, 'card'> | undefined): number {
  return c?.card.stability ?? 0;
}

/** An error-bank item's own drill schedule (a sentence drill, not word progress): due by `now`. */
export function isDrillDue(card: Pick<Card, 'due'>, now: Date): boolean {
  return new Date(card.due).getTime() <= now.getTime();
}

/** Soonest-due first, for error-bank drills. */
export function byDrillDue(a: Pick<Card, 'due'>, b: Pick<Card, 'due'>): number {
  return new Date(a.due).getTime() - new Date(b.due).getTime();
}
