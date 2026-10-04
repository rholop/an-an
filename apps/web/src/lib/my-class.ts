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
const notify = () => listeners.forEach((l) => l());

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
): Promise<{ events: number; cards: number; coveredThrough: number }> {
  if (!setting.enabled) return { events: 0, cards: 0, coveredThrough: setting.coveredThrough ?? 0 };
  const list = Array.isArray(books) ? (books as readonly Textbook[]) : [books as Textbook];
  const from = setting.coveredThrough ?? 0;
  const through =
    courseOrdinal(LAIXUE_COURSE, setting.textbookId, setting.currentLesson) ?? setting.currentLesson;
  const all = lessonCoveredEvidence(list, through, now);
  const ordinalOfLesson = (lessonId: string): number => {
    for (const b of list) {
      const l = b.lessons.find((x) => x.id === lessonId);
      if (l) return courseOrdinal(LAIXUE_COURSE, b.id, l.n) ?? l.n;
    }
    return 0;
  };
  const fresh = all.filter((e) => ordinalOfLesson(e.context?.refId ?? '') > from);
  const cards = fresh.length > 0 ? (await recorder.recordBulk(fresh, now)).length : 0;
  return { events: fresh.length, cards, coveredThrough: Math.max(from, through) };
}

/** Persist + broadcast a change, and record coverage when a book is given. */
export async function setMyClass(
  patch: Partial<MyClassSetting>,
  opts: { books?: readonly Textbook[]; recorder?: CoverageRecorder } = {},
): Promise<{ added: number }> {
  const next = sanitize({ ...current, ...patch });
  current = next;
  loaded = true;
  notify();
  let added = 0;
  if (opts.books && opts.recorder && next.enabled) {
    const r = await recordLessonCoverage(opts.books, next, opts.recorder);
    added = r.cards;
    // Merge into the CURRENT value: another change may have landed while the coverage was recorded.
    current = { ...current, coveredThrough: Math.max(current.coveredThrough ?? 0, r.coveredThrough) };
    notify();
  }
  await db.settings.put({ key: KEY, value: current });
  return { added };
}
