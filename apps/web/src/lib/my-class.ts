import { useSyncExternalStore } from 'react';
import {
  DEFAULT_MY_CLASS,
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

/** What is stored: the setting plus how far lesson evidence has been recorded,
 * so going back a lesson and forward again doesn't re-log everything. */
export interface StoredMyClass extends MyClassSetting {
  coveredThrough?: number;
}

let current: StoredMyClass = { ...DEFAULT_MY_CLASS };
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function sanitize(v: unknown): StoredMyClass {
  const o = (v ?? {}) as Partial<StoredMyClass>;
  const lesson = Number.isInteger(o.currentLesson)
    ? Math.min(10, Math.max(1, o.currentLesson!))
    : 1;
  return {
    enabled: o.enabled === true,
    textbookId: typeof o.textbookId === 'string' ? o.textbookId : DEFAULT_MY_CLASS.textbookId,
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
 * Words and grammar of lessons ≤ current enter the model as `introduced`
 * (never known, no FSRS review of their own). Only lessons not yet covered are
 * recorded. Returns the number of new cards.
 */
export async function recordLessonCoverage(
  book: Textbook,
  setting: StoredMyClass,
  recorder: CoverageRecorder,
  now: Date = new Date(),
): Promise<{ events: number; cards: number; coveredThrough: number }> {
  if (!setting.enabled) return { events: 0, cards: 0, coveredThrough: setting.coveredThrough ?? 0 };
  const from = setting.coveredThrough ?? 0;
  const all = lessonCoveredEvidence(book, setting.currentLesson, now);
  const lessonNo = (id: string) => book.lessons.find((l) => l.id === id)?.n ?? 0;
  const fresh = all.filter((e) => lessonNo(e.context?.refId ?? '') > from);
  const cards = fresh.length > 0 ? (await recorder.recordBulk(fresh, now)).length : 0;
  return {
    events: fresh.length,
    cards,
    coveredThrough: Math.max(from, setting.currentLesson),
  };
}

/** Persist + broadcast a change, and record coverage when a book is given. */
export async function setMyClass(
  patch: Partial<MyClassSetting>,
  opts: { book?: Textbook; recorder?: CoverageRecorder } = {},
): Promise<{ added: number }> {
  const next = sanitize({ ...current, ...patch });
  current = next;
  loaded = true;
  notify();
  let added = 0;
  if (opts.book && opts.recorder && next.enabled) {
    const r = await recordLessonCoverage(opts.book, next, opts.recorder);
    added = r.cards;
    current = { ...next, coveredThrough: r.coveredThrough };
    notify();
  }
  await db.settings.put({ key: KEY, value: current });
  return { added };
}
