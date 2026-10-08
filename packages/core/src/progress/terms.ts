// Phase 21 Part B: the ONLY place that decides what New, Due, Learned and Mastered mean,
// which items make up a lesson or a level, and which words count as comprehensible.
// Every tab, count and validator imports from here (an architecture test enforces it).
// Pure functions; time is always injected.

import { isActiveCard } from '../learner/review-pile.js';
import type { SkillCard } from '../learner/types.js';
import type { Level } from '../levels.config.js';
import type { Lesson } from '../textbook/types.js';
import type { Evidence, ItemRef, Word } from '../types.js';
import { PROGRESS_CONFIG, type ProgressConfig } from './progress.config.js';

export const itemKeyOf = (i: ItemRef): string => `${i.kind}:${i.id}`;

// ---------------------------------------------------------------------------------------------
// Card-level terms

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

/** FSRS is still drilling it (first steps or after a lapse). */
export function isLearningState(c: Pick<SkillCard, 'state'>): boolean {
  return c.state === 'learning';
}

/** **New**: a card that exists but was never answered (it waits to be met). */
export function isNewCard(c: Pick<SkillCard, 'state' | 'card'>): boolean {
  return c.state === 'introduced' && c.card.reps === 0;
}

/** **Due**: answered at least once, due now, and not removed by Nope. `unseen` cards are never due. */
export function isDueCard(c: Pick<SkillCard, 'state' | 'card' | 'flags'>, now: Date): boolean {
  return c.state !== 'unseen' && c.card.reps > 0 && c.card.due.getTime() <= now.getTime() && isActiveCard(c);
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

/** Pinyin fading: strong enough, and the learner isn't leaning on the reading. */
export function readingMayFade(
  c: Pick<SkillCard, 'card' | 'readingDependence'>,
  cfg: { readingFadeStabilityDays: number; readingFadeMaxDependence: number } = PROGRESS_CONFIG,
): boolean {
  return c.card.stability >= cfg.readingFadeStabilityDays && c.readingDependence < cfg.readingFadeMaxDependence;
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

/** A lesson's core items: vocab + grammar words − proper nouns, then its grammar points (de-duplicated). */
export function lessonCoreItems(lesson: Pick<Lesson, 'vocab' | 'grammarWords' | 'properNouns' | 'grammar'>): ItemRef[] {
  const proper = new Set(lesson.properNouns);
  const words = [...new Set([...lesson.vocab, ...(lesson.grammarWords ?? [])])].filter((id) => !proper.has(id));
  return [
    ...words.map((id) => ({ kind: 'word' as const, id })),
    ...[...new Set(lesson.grammar)].map((id) => ({ kind: 'grammar' as const, id })),
  ];
}

/** Word ids of `lessonCoreItems`. */
export function lessonCoreWordIds(lesson: Pick<Lesson, 'vocab' | 'grammarWords' | 'properNouns' | 'grammar'>): string[] {
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
}

/** Correct-use tallies per grammar point from the evidence log (cloze, journal, review). */
export function grammarUsesFromEvidence(
  evidence: readonly Pick<Evidence, 'item' | 'kind' | 'at'>[],
  cfg: Pick<ProgressConfig, 'grammarCorrectKinds' | 'grammarWrongKinds'> = PROGRESS_CONFIG,
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
    out.set(e.item.id, { correct: cur.correct + (correct ? 1 : 0), lastCorrect: correct });
  }
  return out;
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
      if (c.skill === 'listening') continue;
      this.bySkill.set(`${itemKeyOf(c.item)}|${c.skill}`, c);
    }
    this.known = new Set(inputs.knownItems ?? []);
    this.cfg = inputs.config ?? PROGRESS_CONFIG;
    this.grammarUses = inputs.grammarUses ?? new Map();
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
      const u = this.grammarUses.get(i.id);
      if (u && u.correct > 0) return true;
      const r = this.card(i, 'recognition');
      return !!r && isLearnedCard(r);
    }
    const r = this.card(i, 'recognition');
    return !!r && isLearnedCard(r);
  }

  /** **Mastered**: recognition ≥ 21 d and production ≥ 7 d, not a leech; or passed the check and not
   * contradicted since. Grammar: 3 correct uses, the last one correct. */
  mastered(i: ItemRef): boolean {
    if (i.kind === 'grammar') {
      const u = this.grammarUses.get(i.id);
      if (u && u.correct >= this.cfg.mastered.grammarCorrectUses && u.lastCorrect) return true;
      if (this.checkedKnown(this.card(i, 'recognition')) && !(u && !u.lastCorrect)) return true;
      return this.legacyKnown(i);
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

/** Words the learner has Learned (or mastered): the one "known" set every tab uses. */
export function learnedWordIds(index: ProgressIndex, cards: readonly SkillCard[]): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    if (c.item.kind !== 'word' || c.skill === 'listening') continue;
    if (index.learned(c.item)) out.add(c.item.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Comprehensible

/** Token classes a reader is expected to understand (chat validator, open chat, cloze, reader, coverage). */
export const COMPREHENSIBLE_CLASSES: ReadonlySet<string> = new Set(['known', 'due', 'learning', 'allowed']);

/** Word tags that are always fine to show (names, NPC names, particles, fillers). */
export const ALWAYS_ALLOWED_TAGS: ReadonlySet<string> = new Set(['name', 'npc', 'particle', 'filler']);

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

/**
 * The one way to turn cards into the known / due / learning sets the validators classify against.
 * Comprehensible = known ∪ due ∪ learning ∪ allowed (names, numbers, particles, punctuation, extras).
 */
export function wordSets(cards: readonly SkillCard[], now: Date, inputs: Omit<ProgressIndexInputs, 'cards'> = {}): WordSets {
  const index = new ProgressIndex({ ...inputs, cards });
  const knownIds = learnedWordIds(index, cards);
  const dueIds = new Set<string>();
  const learningIds = new Set<string>();
  const newIds = new Set<string>();
  for (const c of cards) {
    if (c.item.kind !== 'word' || c.skill === 'listening' || c.state === 'unseen') continue;
    if (!isActiveCard(c) && !c.flags.markedKnown) continue;
    const id = c.item.id;
    if (isDueCard(c, now)) dueIds.add(id);
    if (knownIds.has(id)) continue;
    if (isNewCard(c)) newIds.add(id);
    else learningIds.add(id);
  }
  for (const id of learningIds) newIds.delete(id);
  for (const id of dueIds) newIds.delete(id);
  return { knownIds, dueIds, learningIds, newIds };
}
