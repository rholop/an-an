import { useSyncExternalStore } from 'react';
import {
  courseBook,
  courseOrdinal,
  DEFAULT_MY_CLASS,
  LAIXUE_COURSE,
  lessonCoveredEvidence,
  type Evidence,
  type MyClassSetting,
  type SkillCard,
  type Textbook,
} from '@anan/core';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import { markStudyDirty } from './study-dirty.js';

/**
 * Phase 12 "My class": per-profile, synced (it lives in the `settings` table,
 * which sync merges). A tiny external store keeps every mounted component in
 * step the moment it changes, mirroring current-level.ts.
 */
const KEY = 'myClass';

/** What is stored: the setting plus how far lesson evidence has been recorded
 * (a COURSE position: for book 1 it is the lesson number, exactly as in Phase 12),
 * so going back a lesson and forward again doesn't re-log everything.
 * Phase 13: `textbookId` + `currentLesson` is "book + lesson"; a Phase 12 value
 * (laixue-1, n) is already that, so no migration step changes behaviour. */
export interface StoredMyClass extends MyClassSetting {
  coveredThrough?: number;
}

let current: StoredMyClass = { ...DEFAULT_MY_CLASS };
let loaded = false;
const listeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
// Phase 21: a My class change changes the study focus, so every tab recomputes.
const notify = () => {
  listeners.forEach((l) => l());
  changeListeners.forEach((l) => l());
  markStudyDirty();
};

/** Called after every change (load, set, sync reload). */
export function onMyClassChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function sanitize(v: unknown): StoredMyClass {
  const o = (v ?? {}) as Partial<StoredMyClass>;
  const book =
    typeof o.textbookId === 'string' && courseBook(LAIXUE_COURSE, o.textbookId)
      ? courseBook(LAIXUE_COURSE, o.textbookId)!
      : courseBook(LAIXUE_COURSE, DEFAULT_MY_CLASS.textbookId)!;
  const lesson = Number.isInteger(o.currentLesson)
    ? Math.min(book.lessons, Math.max(1, o.currentLesson!))
    : 1;
  return {
    enabled: o.enabled === true,
    textbookId: book.id,
    currentLesson: lesson,
    ...(Number.isInteger(o.coveredThrough) ? { coveredThrough: o.coveredThrough } : {}),
  };
}

async function load(): Promise<void> {
  if (loaded || !currentSession()) return;
  loaded = true;
  const forProfile = currentSession()!.profileId;
  let row;
  try {
    row = await db.settings.get(KEY);
  } catch {
    return;
  }
  if (currentSession()?.profileId !== forProfile) return;
  if (row?.value) current = sanitize(row.value);
  notify();
}

onSessionChange((session) => {
  current = { ...DEFAULT_MY_CLASS };
  loaded = false;
  notify();
  if (session) void load();
});

/** After a sync merge replaced the database contents: re-read the setting. */
export function reloadMyClass(): void {
  loaded = false;
  void load();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function peekMyClass(): StoredMyClass {
  return current;
}

export function useMyClass(): StoredMyClass {
  if (!loaded && currentSession()) void load();
  return useSyncExternalStore(subscribe, () => current);
}

export function resetMyClassForTests(): void {
  current = { ...DEFAULT_MY_CLASS };
  loaded = false;
  notify();
}

/** The one thing My class needs from the learner service. */
export interface CoverageRecorder {
  recordBulk(events: Evidence[], now?: Date): Promise<SkillCard[]>;
}

/**
 * Words and grammar of every lesson up to the class position (in COURSE order,
 * so all earlier books count) enter the model as `introduced` (never known, no
 * FSRS review of their own). Only lessons not yet covered are recorded.
 * Returns the number of new cards.
 */
export async function recordLessonCoverage(
  books: Textbook | readonly Textbook[],
  setting: StoredMyClass,
  recorder: CoverageRecorder,
  now: Date = new Date(),
  /** Phase 21: lessons held back by the TOCFL gate (listed, but not introduced into review yet). */
  gatedLessonIds: ReadonlySet<string> = new Set(),
): Promise<{ events: number; cards: number; coveredThrough: number }> {
  if (!setting.enabled) return { events: 0, cards: 0, coveredThrough: setting.coveredThrough ?? 0 };
  const list = Array.isArray(books) ? (books as readonly Textbook[]) : [books as Textbook];
  const from = setting.coveredThrough ?? 0;
  const classAt =
    courseOrdinal(LAIXUE_COURSE, setting.textbookId, setting.currentLesson) ?? setting.currentLesson;
  const ordinalOfLesson = (lessonId: string): number => {
    for (const b of list) {
      const l = b.lessons.find((x) => x.id === lessonId);
      if (l) return courseOrdinal(LAIXUE_COURSE, b.id, l.n) ?? l.n;
    }
    return 0;
  };
  // Coverage stops before the first gated lesson; it resumes (catchUpClassCoverage) once the gate opens.
  const firstGated = Math.min(
    ...[...gatedLessonIds].map(ordinalOfLesson).filter((o) => o > from && o <= classAt),
    Infinity,
  );
  const through = Math.min(classAt, firstGated - 1);
  if (through <= from) return { events: 0, cards: 0, coveredThrough: from };
  const all = lessonCoveredEvidence(list, through, now);
  const fresh = all.filter((e) => ordinalOfLesson(e.context?.refId ?? '') > from);
  const cards = fresh.length > 0 ? (await recorder.recordBulk(fresh, now)).length : 0;
  return { events: fresh.length, cards, coveredThrough: Math.max(from, through) };
}

let catchingUp: Promise<number> | undefined;
/**
 * Phase 21: lessons up to the class that the TOCFL gate held back join review once the gate opens.
 * Cheap when there is nothing to do; one run at a time.
 */
export function catchUpClassCoverage(
  books: readonly Textbook[],
  recorder: CoverageRecorder,
  gatedLessonIds: ReadonlySet<string>,
): Promise<number> {
  if (catchingUp) return catchingUp;
  const at = current;
  const classAt = courseOrdinal(LAIXUE_COURSE, at.textbookId, at.currentLesson) ?? at.currentLesson;
  if (!at.enabled || !loaded || (at.coveredThrough ?? 0) >= classAt || books.length === 0) return Promise.resolve(0);
  catchingUp = (async () => {
    const r = await recordLessonCoverage(books, at, recorder, new Date(), gatedLessonIds);
    if (r.coveredThrough > (current.coveredThrough ?? 0)) {
      current = { ...current, coveredThrough: r.coveredThrough };
      await db.settings.put({ key: KEY, value: current });
    }
    return r.cards;
  })().finally(() => {
    catchingUp = undefined;
  });
  return catchingUp;
}

/** Persist + broadcast a change, and record coverage when a book is given. */
export async function setMyClass(
  patch: Partial<MyClassSetting>,
  opts: { books?: readonly Textbook[]; recorder?: CoverageRecorder; gatedLessonIds?: ReadonlySet<string> } = {},
): Promise<{ added: number }> {
  const next = sanitize({ ...current, ...patch });
  current = next;
  loaded = true;
  notify();
  // Saved at once (not only after the coverage below), so leaving the page right away keeps it.
  await db.settings.put({ key: KEY, value: current });
  let added = 0;
  if (opts.books && opts.recorder && next.enabled) {
    const r = await recordLessonCoverage(opts.books, next, opts.recorder, new Date(), opts.gatedLessonIds);
    added = r.cards;
    // Merge into the CURRENT value: another change may have landed while the coverage was recorded.
    current = { ...current, coveredThrough: Math.max(current.coveredThrough ?? 0, r.coveredThrough) };
    notify();
  }
  await db.settings.put({ key: KEY, value: current });
  return { added };
}
