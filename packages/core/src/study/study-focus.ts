// Phase 14: ONE study order. `getStudyFocus` is the single selector every tab
// asks "what should be prioritised?"; no tab has its own priority logic.
//
// The order is tiers over the TOCFL levels. A tier = the textbook lessons at that
// level (course order), then the rest of that level's TOCFL words. A lesson is never
// active while a lower TOCFL level is below mastery.

import { PRIORITY_CONFIG, type PriorityConfig } from '../curriculum/priority.config.js';
import { PROGRESS_CONFIG } from '../progress/progress.config.js';
import type { SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import { LEVEL_IDS, tocflLabel, type Level } from '../levels.config.js';
import { bookTitle, courseBook, courseLessonLevel, courseOrdinal, LAIXUE_COURSE, lessonBadge, type Course } from '../textbook/course.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import { lessonCoreItems, lessonCoreWordIds, lessonExtraWordIds, lessonTaughtItems, levelItems, ProgressIndex, type GrammarUse, type LearnedMastered } from '../progress/terms.js';
import type { ItemRef } from '../types.js';

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
  /** Phase 34: teach a lesson's extra words with the lesson (Settings → Study). */
  teachExtras: boolean;
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = {
  enabled: true,
  masteryShare: PRIORITY_CONFIG.mastery.lessonShare,
  classAheadLessons: PRIORITY_CONFIG.classAheadLessons,
  reached: 0,
  knownItems: [],
  teachExtras: true,
};

export type { GrammarUse };

/** Phase 34: do the extra words count toward lesson mastery now? (The flag, and only while they are taught.) */
export function extrasCountForMastery(cfg: PriorityConfig | undefined, settings: Pick<StudySettings, 'teachExtras'>): boolean {
  return (cfg ?? PRIORITY_CONFIG).extrasCountForLessonMastery && settings.teachExtras !== false;
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
  /** Phase 29 Part A.1: the ledger's own index (the ledger always passes it, so Now studying and
   * the lesson numbers are the same Learned / Mastered). Absent only in direct unit tests. */
  index?: ProgressIndex;
}

export interface Mastery {
  mastered: number;
  /** Phase 21: Learned count / share over the same items (the second number every screen shows). */
  learned: number;
  learnedShare: number;
  total: number;
  /** Mastered share. */
  share: number;
  /** Same as `share`, under the shared name (Phase 21 Part C display). */
  masteredShare: number;
  leeches: number;
  imported: number;
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
  /** Earlier lessons not (or no longer) mastered: their items come after the active lesson's.
   * Phase 21: with My class set these are the "catch-up lessons". */
  reviewLessons: Array<Extract<StepRef, { kind: 'lesson' }>>;
  /** Phase 21: the class lesson (My class on), whether or not it is active (it may be gated). */
  classLesson?: Extract<StepRef, { kind: 'lesson' }>;
  /** Phase 21: the active lesson is the class lesson (or a preview within `classAheadLessons`). */
  activeIsClass?: boolean;
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
  /** Phase 21: lesson ids already mastered (skipped by "the next lessons" everywhere). */
  masteredLessonIds?: string[];
}

const itemKey = (i: ItemRef) => `${i.kind}:${i.id}`;


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

/** Phase 21: mastery comes from the shared ProgressIndex (one definition for every tab). */
function masteryIndexOf(p: StudyProfile, cfg: PriorityConfig): ProgressIndex {
  return new ProgressIndex({
    cards: p.cards,
    grammarUses: p.grammarUses,
    knownItems: p.settings.knownItems,
    config: {
      ...PROGRESS_CONFIG,
      mastered: { ...PROGRESS_CONFIG.mastered, ...cfg.mastery },
    },
  });
}

export interface StepItems {
  words: string[];
  grammar: string[];
}


function toMastery(sum: LearnedMastered, threshold: number): Mastery {
  return {
    mastered: sum.mastered,
    learned: sum.learned,
    learnedShare: sum.learnedShare,
    total: sum.total,
    share: sum.masteredShare,
    masteredShare: sum.masteredShare,
    leeches: sum.leeches,
    imported: sum.imported,
    isMastered: sum.masteredShare >= threshold,
    remainingWords: sum.remainingWords,
    remainingGrammar: sum.remainingGrammar,
  };
}

/** The single selector. Pure: time and storage are injected via `now` / the profile. */
export function getStudyFocus(profile: StudyProfile, _now: Date = new Date()): StudyFocus {
  void _now;
  const cfg = profile.config ?? PRIORITY_CONFIG;
  const course = profile.course ?? LAIXUE_COURSE;
  const steps = studySteps(profile.books, course);
  const idx = profile.index ?? masteryIndexOf(profile, cfg);
  const allWords = profile.lexicon.allWords();
  const lessonById = new Map<string, Lesson>();
  for (const b of profile.books) for (const l of b.lessons) lessonById.set(l.id, l);

  // Words covered by some lesson's core vocabulary (so "the rest of the level" excludes them).
  const inLesson = new Set<string>();
  for (const l of lessonById.values()) for (const id of [...lessonCoreWordIds(l), ...lessonExtraWordIds(l)]) inLesson.add(id);
  const teachExtras = profile.settings.teachExtras !== false;
  const withExtras = extrasCountForMastery(cfg, profile.settings);

  const share = profile.settings.masteryShare;
  const levelWords = new Map<Level, ItemRef[]>();
  for (const lv of LEVEL_IDS) levelWords.set(lv, levelItems(lv, allWords));
  const freqOf = new Map(allWords.map((w) => [w.id, w.freqRank ?? Infinity]));

  const itemsOfStep = (s: StepRef): ItemRef[] => allItemsOfStep(s).filter((i) => !idx.removed(i));
  const allItemsOfStep = (s: StepRef): ItemRef[] => {
    if (s.kind === 'lesson') {
      return lessonCoreItems(lessonById.get(s.lessonId)!, { withExtras });
    }
    return (levelWords.get(s.level) ?? [])
      .filter((w) => !inLesson.has(w.id))
      .sort((a, b) => (freqOf.get(a.id) ?? Infinity) - (freqOf.get(b.id) ?? Infinity) || a.id.localeCompare(b.id));
  };

  const masteryOf = (items: ItemRef[], threshold: number): Mastery => toMastery(idx.summarize(items), threshold);

  // A TOCFL level is mastered over ALL its words (textbook words count too).
  const levelMastery = new Map<Level, Mastery>();
  for (const lv of LEVEL_IDS) {
    levelMastery.set(
      lv,
      masteryOf((levelWords.get(lv) ?? []).filter((i) => !idx.removed(i)), cfg.mastery.levelShare),
    );
  }
  // Phase 21 Part C: "TOCFL X (rest)" shows numbers for the rest only (what it actually studies);
  // it is done when the whole LEVEL is mastered (the gate shows the whole-level number).
  const stepMastery = (s: StepRef): Mastery => {
    if (s.kind === 'lesson') return masteryOf(itemsOfStep(s), share);
    const lm = levelMastery.get(s.level)!;
    return { ...masteryOf(itemsOfStep(s), cfg.mastery.levelShare), isMastered: lm.isMastered || lm.total === 0 };
  };

  const firstUnmasteredLevelBelow = (level: Level): Level | undefined =>
    LEVEL_IDS.slice(0, LEVEL_IDS.indexOf(level)).find((lv) => !levelMastery.get(lv)!.isMastered);

  // Pointer: advance across steps that are mastered now. Never moves backwards.
  const before = profile.settings.reached;
  let p = Math.min(Math.max(0, before), steps.length);
  while (p < steps.length && stepMastery(steps[p]!).isMastered) p++;

  // Phase 21: with My class set the class lesson is a FLOOR as well as a cap: the active lesson is
  // the class lesson (or a preview up to `classAheadLessons` ahead), never an earlier one. Earlier
  // unmastered lessons become catch-up lessons. The TOCFL gate still wins.
  const classOrdinal =
    profile.myClass?.enabled
      ? (courseOrdinal(course, profile.myClass.textbookId, profile.myClass.currentLesson) ?? undefined)
      : undefined;
  const cap = classOrdinal === undefined ? Infinity : classOrdinal + profile.settings.classAheadLessons;

  let active: StepRef | undefined;
  let gate: GateStatus = { blocked: false };
  for (let i = classOrdinal === undefined ? p : 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (stepMastery(s).isMastered) continue;
    if (s.kind === 'lesson') {
      if (classOrdinal !== undefined && s.ordinal < classOrdinal) continue; // catch-up, not active
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

  // Review / catch-up lessons: earlier lessons (before the pointer / active) not mastered, earliest first.
  const activeIndex = active ? steps.findIndex((s) => stepKey(s) === stepKey(active!)) : steps.length;
  const reviewLessons = steps
    .slice(0, Math.max(activeIndex, p))
    .filter((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson')
    .filter((s) => stepKey(s) !== (active ? stepKey(active) : ''))
    .filter((s) => !stepMastery(s).isMastered);

  const focusItems = active ? itemsOfStep(active).filter((i) => !idx.mastered(i)) : [];
  const reviewItems = reviewLessons.flatMap((s) => itemsOfStep(s).filter((i) => !idx.mastered(i)));
  // Part A: the active lesson's new items first, then the catch-up lessons' (earliest first),
  // never a lesson held back by the TOCFL gate.
  const seenNew = new Set<string>();
  // Phase 34: extra words follow the core words, earliest lesson first: the extras of lessons already
  // passed (catch-up), then the active lesson's own. They are never "to master", only to introduce.
  const extraItemsOf = (s: StepRef): ItemRef[] =>
    s.kind === 'lesson' && teachExtras
      ? lessonTaughtItems(lessonById.get(s.lessonId)!, true).slice(lessonCoreItems(lessonById.get(s.lessonId)!).length)
      : [];
  const activeKey = active ? stepKey(active) : '';
  const passedLessons = steps
    .slice(0, Math.max(activeIndex, p))
    .filter((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson')
    .filter((s) => stepKey(s) !== activeKey && firstUnmasteredLevelBelow(s.level) === undefined);
  const newItemsAllowed = [
    ...focusItems,
    ...reviewLessons
      .filter((s) => firstUnmasteredLevelBelow(s.level) === undefined)
      .flatMap((s) => itemsOfStep(s).filter((i) => !idx.mastered(i))),
    ...passedLessons.flatMap((s) => extraItemsOf(s).filter((i) => !idx.removed(i))),
    ...(active ? extraItemsOf(active).filter((i) => !idx.removed(i)) : []),
  ].filter((i) => {
    const k = itemKey(i);
    if (idx.hasCard(i) || seenNew.has(k)) return false;
    seenNew.add(k);
    return true;
  });

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
        message: `${classBook ? bookTitle(classBook.id, course) : 'The class book'} unlocks after ${tocflLabel(waiting)}: ${Math.round(lm.share * 100)}% mastered`,
      };
    }
  } else if (gate.blocked && gate.waitingForLevel) {
    gate.message = `Lessons unlock after ${tocflLabel(gate.waitingForLevel)}: ${Math.round((gate.levelShare ?? 0) * 100)}% mastered`;
  }

  const nextStep = (() => {
    if (!active) return undefined;
    const i = steps.findIndex((s) => stepKey(s) === stepKey(active!));
    return steps.slice(i + 1).find((s) => !stepMastery(s).isMastered);
  })();

  const classLesson =
    classOrdinal === undefined
      ? undefined
      : steps.find((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson' && s.ordinal === classOrdinal);
  const activeIsClass =
    classOrdinal !== undefined && active?.kind === 'lesson' && active.ordinal >= classOrdinal && active.ordinal <= cap;

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
    ...(classLesson ? { classLesson } : {}),
    ...(classOrdinal !== undefined ? { activeIsClass } : {}),
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
    masteredLessonIds: steps
      .filter((s): s is Extract<StepRef, { kind: 'lesson' }> => s.kind === 'lesson')
      .filter((s) => stepMastery(s).isMastered)
      .map((s) => s.lessonId),
  };
}

/** Display name of a step ("來學華語 1 · Lesson 3" / "TOCFL N2 (rest)"); formats from the label functions. */
export function stepName(s: StepRef, course: Course = LAIXUE_COURSE): string {
  if (s.kind === 'level') return `${tocflLabel(s.level)} (rest)`;
  return lessonBadge(s.n, s.bookId, course);
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
export function lessonIndex(books: readonly Textbook[], course: Course = LAIXUE_COURSE, withExtras = true): Map<string, string> {
  const out = new Map<string, string>();
  const ordered = books
    .flatMap((b) => b.lessons.map((l) => ({ l, o: courseOrdinal(course, b.id, l.n) ?? 999 })))
    .sort((a, b) => a.o - b.o);
  for (const { l } of ordered) {
    for (const i of lessonTaughtItems(l, withExtras)) {
      const key = `${i.kind}:${i.id}`;
      if (!out.has(key)) out.set(key, l.id);
    }
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
