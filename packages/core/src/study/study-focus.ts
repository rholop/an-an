// Phase 14: ONE study order. `getStudyFocus` is the single selector every tab
// asks "what should be prioritised?"; no tab has its own priority logic.
//
// The order is tiers over the TOCFL levels. A tier = the textbook lessons at that
// level (course order), then the rest of that level's TOCFL words. A lesson is never
// active while a lower TOCFL level is below mastery.

import { PRIORITY_CONFIG, type PriorityConfig } from '../curriculum/priority.config.js';
import type { SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import { LEVEL_IDS, type Level } from '../levels.config.js';
import { courseBook, courseLessonLevel, courseOrdinal, LAIXUE_COURSE, type Course } from '../textbook/course.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Evidence, ItemRef, Word } from '../types.js';

export type StepRef =
  | { kind: 'lesson'; bookId: string; n: number; lessonId: string; level: Level; ordinal: number }
  | { kind: 'level'; level: Level };

export const stepKey = (s: StepRef): string =>
  s.kind === 'lesson' ? `lesson:${s.lessonId}` : `level:${s.level}`;

export interface StudySettings {
  /** Study order on/off. Off restores the previous behaviour exactly. */
  enabled: boolean;
  masteryShare: number;
  /** How many lessons the active lesson may run ahead of class. */
  classAheadLessons: number;
  /** Furthest step index the pointer has passed (monotone; synced with the profile). */
  reached: number;
  /** Items ("word:id" / "grammar:id") that passed the "already known" quick check. */
  knownItems: readonly string[];
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = {
  enabled: true,
  masteryShare: PRIORITY_CONFIG.mastery.lessonShare,
  classAheadLessons: PRIORITY_CONFIG.classAheadLessons,
  reached: 0,
  knownItems: [],
};

export interface GrammarUse {
  correct: number;
  lastCorrect: boolean;
}

export interface StudyProfile {
  lexicon: Pick<Lexicon, 'allWords' | 'byId'>;
  /** Imported books in course order. */
  books: readonly Textbook[];
  /** Every touched card (both skills). */
  cards: readonly SkillCard[];
  grammarUses: ReadonlyMap<string, GrammarUse>;
  myClass?: { enabled: boolean; textbookId: string; currentLesson: number };
  settings: StudySettings;
  course?: Course;
  config?: PriorityConfig;
}

export interface Mastery {
  mastered: number;
  total: number;
  share: number;
  isMastered: boolean;
  /** Items still to master, in study order. */
  remainingWords: number;
  remainingGrammar: number;
}

export interface GateStatus {
  /** The class (or the next lessons) sit beyond what the study order has unlocked. */
  blocked: boolean;
  /** Level that has to be mastered first. */
  waitingForLevel?: Level;
  levelShare?: number;
  /** Human reading, e.g. "Book 2 unlocks after TOCFL Novice 1: 82% mastered". */
  message?: string;
  /** The active step is held back by the class position (preview limit). */
  cappedByClass?: boolean;
}

export interface StudyFocus {
  enabled: boolean;
  steps: StepRef[];
  activeStep: StepRef | undefined;
  activeLesson?: Extract<StepRef, { kind: 'lesson' }>;
  activeLevel?: Level;
  /** Earlier lessons that slipped below mastery: their weak items are mixed back in. */
  reviewLessons: Array<Extract<StepRef, { kind: 'lesson' }>>;
  /** Unmastered items of the active step, in introduction order. */
  focusItems: ItemRef[];
  /** Unmastered items of the review lessons. */
  reviewItems: ItemRef[];
  /** Items that may be INTRODUCED now (no card yet), in order. Empty set = nothing new beyond the active step. */
  newItemsAllowed: ItemRef[];
  /** false = nothing outside the active step may be introduced (aheadShare 0). */
  generalNewItemsAllowed: boolean;
  gateStatus: GateStatus;
  mastery: Mastery | undefined;
  nextStep: StepRef | undefined;
  /** New pointer to persist (monotone). */
  reached: number;
  /** Lessons that have just become mastered relative to `reached` input (for the celebration). */
  justMastered: Array<Extract<StepRef, { kind: 'lesson' }>>;
  /** Phase 18: lesson ids held back by an unmastered lower TOCFL level (they don't count as "upcoming"). */
  gatedLessonIds?: string[];
}

const itemKey = (i: ItemRef) => `${i.kind}:${i.id}`;

function lessonCoreWords(l: Lesson): string[] {
  const proper = new Set(l.properNouns);
  return [...new Set(l.vocab)].filter((id) => !proper.has(id));
}

/** Tiers: for each TOCFL level in order, its lessons (course order), then "the rest of the level". */
export function studySteps(
  books: readonly Textbook[],
  course: Course = LAIXUE_COURSE,
): StepRef[] {
  const lessons: Array<Extract<StepRef, { kind: 'lesson' }>> = [];
  for (const b of books) {
    if (!courseBook(course, b.id)) continue;
    for (const l of b.lessons) {
      const ordinal = courseOrdinal(course, b.id, l.n);
      if (ordinal === undefined) continue;
      lessons.push({
        kind: 'lesson',
        bookId: b.id,
        n: l.n,
        lessonId: l.id,
        level: courseLessonLevel(course, b.id, l.n),
        ordinal,
      });
    }
  }
  lessons.sort((a, b) => a.ordinal - b.ordinal);
  const steps: StepRef[] = [];
  for (const level of LEVEL_IDS) {
    steps.push(...lessons.filter((l) => l.level === level));
    steps.push({ kind: 'level', level });
  }
  return steps;
}

/** Correct-use tallies per grammar point from the evidence log (typed/reorder cloze, journal). */
export function grammarUsesFromEvidence(
  evidence: readonly Pick<Evidence, 'item' | 'kind' | 'at'>[],
  config: PriorityConfig = PRIORITY_CONFIG,
): Map<string, GrammarUse> {
  const ok = new Set<string>(config.grammarCorrectKinds);
  const bad = new Set<string>(config.grammarWrongKinds);
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

/** Everything `getStudyFocus` needs about mastery, built once. */
class MasteryIndex {
  private readonly bySkill = new Map<string, SkillCard>();
  private readonly known: Set<string>;
  constructor(private readonly p: StudyProfile, private readonly cfg: PriorityConfig) {
    for (const c of p.cards) this.bySkill.set(`${c.item.kind}:${c.item.id}|${c.skill}`, c);
    this.known = new Set(p.settings.knownItems);
  }
  card(i: ItemRef, skill: 'recognition' | 'production'): SkillCard | undefined {
    return this.bySkill.get(`${itemKey(i)}|${skill}`);
  }
  /** Phase 20: "Not now" / "Never show" words leave lesson and level counts (they can't block progress). */
  removed(i: ItemRef): boolean {
    if (i.kind !== 'word') return false;
    const cards = [this.card(i, 'recognition'), this.card(i, 'production')].filter((c): c is SkillCard => !!c);
    return cards.some((c) => c.flags.excluded || c.flags.snoozed);
  }
  hasCard(i: ItemRef): boolean {
    return !!this.card(i, 'recognition') || !!this.card(i, 'production');
  }
  mastered(i: ItemRef): boolean {
    if (i.kind === 'grammar') {
      const u = this.p.grammarUses.get(i.id);
      if (u && u.correct >= this.cfg.mastery.grammarCorrectUses && u.lastCorrect) return true;
      return this.known.has(itemKey(i)) && !(u && !u.lastCorrect);
    }
    const r = this.card(i, 'recognition');
    const pr = this.card(i, 'production');
    if (r?.leech || pr?.leech) return false;
    // Phase 20: "I already know it" counts only once a later review has passed.
    const unproven = (c: SkillCard | undefined) =>
      !!c?.flags.markedKnown &&
      !(c.card.last_review && c.flags.markedKnownAt && new Date(c.card.last_review) > new Date(c.flags.markedKnownAt));
    if (unproven(r) || unproven(pr)) return false;
    if (
      r &&
      pr &&
      r.card.stability >= this.cfg.mastery.recognitionStabilityDays &&
      pr.card.stability >= this.cfg.mastery.productionStabilityDays
    )
      return true;
    // Passed the "already known" check and nothing has contradicted it since.
    return this.known.has(itemKey(i)) && !(r && r.lapses > 0 && r.card.stability < 1);
  }
}

export interface StepItems {
  words: string[];
  grammar: string[];
}

function wordsOfLevel(words: readonly Word[], level: Level): Word[] {
  return words.filter((w) => w.source === 'tocfl' && w.level === level);
}

/** The single selector. Pure: time and storage are injected via `now` / the profile. */
export function getStudyFocus(profile: StudyProfile, _now: Date = new Date()): StudyFocus {
  void _now;
  const cfg = profile.config ?? PRIORITY_CONFIG;
  const course = profile.course ?? LAIXUE_COURSE;
  const steps = studySteps(profile.books, course);
  const idx = new MasteryIndex(profile, cfg);
  const allWords = profile.lexicon.allWords();
  const lessonById = new Map<string, Lesson>();
  for (const b of profile.books) for (const l of b.lessons) lessonById.set(l.id, l);

  // Words covered by some lesson's core vocabulary (so "the rest of the level" excludes them).
  const inLesson = new Set<string>();
  for (const l of lessonById.values()) for (const id of lessonCoreWords(l)) inLesson.add(id);

  const share = profile.settings.masteryShare;
  const levelWords = new Map<Level, Word[]>();
  for (const lv of LEVEL_IDS) levelWords.set(lv, wordsOfLevel(allWords, lv));

  const itemsOfStep = (s: StepRef): ItemRef[] => allItemsOfStep(s).filter((i) => !idx.removed(i));
  const allItemsOfStep = (s: StepRef): ItemRef[] => {
    if (s.kind === 'lesson') {
      const l = lessonById.get(s.lessonId)!;
      return [
        ...lessonCoreWords(l).map((id) => ({ kind: 'word' as const, id })),
        ...[...new Set(l.grammar)].map((id) => ({ kind: 'grammar' as const, id })),
      ];
    }
    return (levelWords.get(s.level) ?? [])
      .filter((w) => !inLesson.has(w.id))
      .sort((a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity) || a.id.localeCompare(b.id))
      .map((w) => ({ kind: 'word' as const, id: w.id }));
  };

  const masteryOf = (items: ItemRef[], threshold: number): Mastery => {
    const done = items.filter((i) => idx.mastered(i));
    const total = items.length;
    const s = total === 0 ? 1 : done.length / total;
    const rest = items.filter((i) => !idx.mastered(i));
    return {
      mastered: done.length,
      total,
      share: s,
      isMastered: s >= threshold,
      remainingWords: rest.filter((i) => i.kind === 'word').length,
      remainingGrammar: rest.filter((i) => i.kind === 'grammar').length,
    };
  };

  // A TOCFL level is mastered over ALL its words (textbook words count too).
  const levelMastery = new Map<Level, Mastery>();
  for (const lv of LEVEL_IDS) {
    levelMastery.set(
      lv,
      masteryOf(
        (levelWords.get(lv) ?? []).map((w) => ({ kind: 'word' as const, id: w.id })),
        cfg.mastery.levelShare,
      ),
    );
  }
  const stepMastery = (s: StepRef): Mastery =>
    s.kind === 'level'
      ? // "the rest of level X" is done when the LEVEL is mastered
        { ...levelMastery.get(s.level)!, ...(levelMastery.get(s.level)!.total === 0 ? { isMastered: true } : {}) }
      : masteryOf(itemsOfStep(s), share);

  const firstUnmasteredLevelBelow = (level: Level): Level | undefined =>
    LEVEL_IDS.slice(0, LEVEL_IDS.indexOf(level)).find((lv) => !levelMastery.get(lv)!.isMastered);

  // Pointer: advance across steps that are mastered now. Never moves backwards.
  const before = profile.settings.reached;
  let p = Math.min(Math.max(0, before), steps.length);
  while (p < steps.length && stepMastery(steps[p]!).isMastered) p++;

  // Class cap: lessons more than N ahead of the class are not active.
  const classOrdinal =
    profile.myClass?.enabled
      ? (courseOrdinal(course, profile.myClass.textbookId, profile.myClass.currentLesson) ?? undefined)
      : undefined;
  const cap = classOrdinal === undefined ? Infinity : classOrdinal + profile.settings.classAheadLessons;

  let active: StepRef | undefined;
  let gate: GateStatus = { blocked: false };
  for (let i = p; i < steps.length; i++) {
    const s = steps[i]!;
    if (stepMastery(s).isMastered) continue;
    if (s.kind === 'lesson') {
      const waiting = firstUnmasteredLevelBelow(s.level);
      if (waiting) {
        // The gate wins: fall back to the lower level's remaining words.
        active = { kind: 'level', level: waiting };
        gate = {
          blocked: true,
          waitingForLevel: waiting,
          levelShare: levelMastery.get(waiting)!.share,
        };
        break;
      }
      if (s.ordinal > cap) {
        gate = { ...gate, cappedByClass: true };
        continue; // wait for the class: study general items meanwhile
      }
    }
    active = s;
    break;
  }
  if (!active) {
    // Nothing allowed at or after the pointer (pointer far ahead, or everything ahead capped/mastered):
    // the study order never leaves a TOCFL level behind, so fall back to the lowest unmastered level.
    const lv = LEVEL_IDS.find((l) => !levelMastery.get(l)!.isMastered && itemsOfStep({ kind: 'level', level: l }).some((i) => !idx.mastered(i)));
    if (lv) active = { kind: 'level', level: lv };
  }

  // Review lessons: earlier lessons (before the pointer / active) that slipped below mastery.
  const activeIndex = active ? steps.findIndex((s) => stepKey(s) === stepKey(active!)) : steps.length;
  const reviewLessons = steps
    .slice(0, Math.max(activeIndex, p))
    .filter((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson')
    .filter((s) => stepKey(s) !== (active ? stepKey(active) : ''))
    .filter((s) => !stepMastery(s).isMastered);

  const focusItems = active ? itemsOfStep(active).filter((i) => !idx.mastered(i)) : [];
  const reviewItems = reviewLessons.flatMap((s) => itemsOfStep(s).filter((i) => !idx.mastered(i)));
  const newItemsAllowed = focusItems.filter((i) => !idx.hasCard(i));

  // Gate message for the class: the class is beyond what the order has unlocked.
  if (classOrdinal !== undefined && active) {
    const classBook = courseBook(course, profile.myClass!.textbookId);
    const classLevel = courseLessonLevel(course, profile.myClass!.textbookId, profile.myClass!.currentLesson);
    const waiting = firstUnmasteredLevelBelow(classLevel);
    if (waiting) {
      const lm = levelMastery.get(waiting)!;
      gate = {
        ...gate,
        blocked: true,
        waitingForLevel: waiting,
        levelShare: lm.share,
        message: `${classBook ? `${classBook.titleZh.split(' ')[0]} ${Number(/(\d+)$/.exec(classBook.id)?.[1] ?? 0)}` : 'The class book'} unlocks after TOCFL ${tocflName(waiting)}: ${Math.round(lm.share * 100)}% mastered`,
      };
    }
  } else if (gate.blocked && gate.waitingForLevel) {
    gate.message = `Lessons unlock after TOCFL ${tocflName(gate.waitingForLevel)}: ${Math.round((gate.levelShare ?? 0) * 100)}% mastered`;
  }

  const nextStep = (() => {
    if (!active) return undefined;
    const i = steps.findIndex((s) => stepKey(s) === stepKey(active!));
    return steps.slice(i + 1).find((s) => !stepMastery(s).isMastered);
  })();

  const justMastered = steps
    .slice(Math.min(before, steps.length), p)
    .filter((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson');

  return {
    enabled: profile.settings.enabled,
    steps,
    activeStep: active,
    ...(active?.kind === 'lesson' ? { activeLesson: active } : {}),
    ...(active?.kind === 'level' ? { activeLevel: active.level } : {}),
    reviewLessons,
    focusItems,
    reviewItems,
    newItemsAllowed,
    generalNewItemsAllowed: cfg.aheadShare > 0,
    gateStatus: gate,
    mastery: active ? stepMastery(active) : undefined,
    nextStep,
    reached: p,
    justMastered,
    gatedLessonIds: steps
      .filter((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson')
      .filter((s) => firstUnmasteredLevelBelow(s.level) !== undefined)
      .map((s) => s.lessonId),
  };
}

/** "Novice 1", "Level 2" — for gate messages and the home card. */
export function tocflName(level: Level): string {
  return level.startsWith('N') ? `Novice ${level.slice(1)}` : `Level ${level.slice(1)}`;
}

/** Display name of a step ("來學華語 1 · Lesson 3" / "TOCFL Novice 2 (rest)"). */
export function stepName(s: StepRef, course: Course = LAIXUE_COURSE): string {
  if (s.kind === 'level') return `TOCFL ${tocflName(s.level)} (rest)`;
  const b = courseBook(course, s.bookId);
  const no = Number(/(\d+)$/.exec(s.bookId)?.[1] ?? 0);
  return `${b?.titleZh.split(' ')[0] ?? s.bookId} ${no} · Lesson ${s.n}`;
}

/**
 * Textbook-first ordering for due reviews (never skipped, only ordered): active
 * lesson → review lessons → earlier textbook lessons → later textbook → everything else.
 */
export function studyRank(
  focus: Pick<StudyFocus, 'activeStep' | 'reviewLessons' | 'steps'>,
  lessonOf: (item: ItemRef) => string | undefined,
  item: ItemRef,
): number {
  const lessonId = lessonOf(item);
  if (!lessonId) return 4;
  const act = focus.activeStep?.kind === 'lesson' ? focus.activeStep.lessonId : undefined;
  if (lessonId === act) return 0;
  if (focus.reviewLessons.some((l) => l.lessonId === lessonId)) return 1;
  const order = focus.steps.filter((s) => s.kind === 'lesson');
  const li = order.findIndex((s) => s.kind === 'lesson' && s.lessonId === lessonId);
  const ai = act ? order.findIndex((s) => s.kind === 'lesson' && s.lessonId === act) : order.length;
  if (li < 0) return 4;
  return li < ai ? 2 : 3;
}

/** item key → the lesson that first teaches it (course order), for `studyRank`. */
export function lessonIndex(books: readonly Textbook[], course: Course = LAIXUE_COURSE): Map<string, string> {
  const out = new Map<string, string>();
  const ordered = books
    .flatMap((b) => b.lessons.map((l) => ({ l, o: courseOrdinal(course, b.id, l.n) ?? 999 })))
    .sort((a, b) => a.o - b.o);
  for (const { l } of ordered) {
    const proper = new Set(l.properNouns);
    for (const id of l.vocab) if (!proper.has(id) && !out.has(`word:${id}`)) out.set(`word:${id}`, l.id);
    for (const id of l.grammar) if (!out.has(`grammar:${id}`)) out.set(`grammar:${id}`, l.id);
  }
  return out;
}

/** Stable sort of due cards, textbook first (study order on). */
export function orderDueCards<T extends { item: ItemRef }>(
  cards: readonly T[],
  focus: StudyFocus,
  index: ReadonlyMap<string, string>,
): T[] {
  if (!focus.enabled) return [...cards];
  const rank = (c: T) => studyRank(focus, (i) => index.get(`${i.kind}:${i.id}`), c.item);
  return cards.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}
