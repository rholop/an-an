import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_STUDY_SETTINGS,
  lessonIndex,
  classScope,
  type ClassScope,
  type Lexicon,
  type StudyFocus,
  type StudySettings,
  type Textbook,
} from '@anan/core';
import { currentSession, db, learnerService, onSessionChange } from '../db/instance.js';
import { getLedgerNow, setLedgerStudySource } from './ledger.js';
import { setKnownItemsSource } from './learner-service.js';
import { catchUpClassCoverage, peekMyClass, useMyClass } from './my-class.js';
import { registerAfterMerge } from './profile-controller.js';
import { markStudyDirty, onStudyDirty } from './study-dirty.js';
import { useLexicon } from './useLexicon.js';
import { useTextbook } from './textbook-data.js';

/**
 * Phase 14: the app side of the one study order. Settings live in the profile's `settings`
 * table (so they sync with the profile); `getStudyFocus` (core) does all the deciding.
 */
const KEY = 'studyOrder';

let settings: StudySettings = { ...DEFAULT_STUDY_SETTINGS };
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => {
  listeners.forEach((l) => l());
  markStudyDirty();
};

function sanitize(v: unknown): StudySettings {
  const o = (v ?? {}) as Partial<StudySettings>;
  const num = (x: unknown, d: number, lo: number, hi: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  return {
    enabled: o.enabled !== false,
    masteryShare: num(o.masteryShare, DEFAULT_STUDY_SETTINGS.masteryShare, 0.5, 1),
    classAheadLessons: Math.round(num(o.classAheadLessons, DEFAULT_STUDY_SETTINGS.classAheadLessons, 0, 5)),
    reached: Math.round(num(o.reached, 0, 0, 1000)),
    knownItems: Array.isArray(o.knownItems) ? o.knownItems.filter((x): x is string => typeof x === 'string') : [],
  };
}

setKnownItemsSource(() => settings.knownItems);

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
  if (row?.value) settings = sanitize(row.value);
  notify();
}

onSessionChange((session) => {
  settings = { ...DEFAULT_STUDY_SETTINGS };
  loaded = false;
  // Phase 21: nothing from the previous profile survives a switch.
  pendingCelebrations = [];
  notify();
  if (session) void load();
});

/** After a sync merge replaced the database contents (called by the profile controller). */
export function reloadStudySettings(): void {
  loaded = false;
  void load().then(() => markStudyDirty());
}

registerAfterMerge(reloadStudySettings);

/**
 * Phase 21 sync-safe merge of two copies of the study settings: `knownItems` is a union and
 * `reached` a max, so neither a sync merge nor a stale in-memory copy can lose progress.
 */
export function mergeStudySettings(a: StudySettings, b: StudySettings): StudySettings {
  return {
    ...b,
    reached: Math.max(a.reached, b.reached),
    knownItems: [...new Set([...a.knownItems, ...b.knownItems])],
  };
}

export function peekStudySettings(): StudySettings {
  return settings;
}

export async function updateStudySettings(patch: Partial<StudySettings>): Promise<void> {
  settings = sanitize({ ...settings, ...patch });
  loaded = true;
  notify();
  // Phase 21: merge with what is stored (a sync may have landed since this copy was read).
  let stored: StudySettings | undefined;
  try {
    const row = await db.settings.get(KEY);
    if (row?.value) stored = sanitize(row.value);
  } catch {
    /* no row yet */
  }
  if (stored) settings = sanitize(mergeStudySettings(stored, settings));
  await db.settings.put({ key: KEY, value: settings });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useStudySettings(): StudySettings {
  if (!loaded && currentSession()) void load();
  return useSyncExternalStore(subscribe, () => settings);
}

// ---- the study context (lexicon + imported books), registered by the provider in App
let ctx: { lexicon: Lexicon; books: Textbook[] } | undefined;
export function registerStudyContext(c: { lexicon: Lexicon; books: Textbook[] } | undefined): void {
  ctx = c;
  markStudyDirty();
}

/** E2E hook (like anan.sync.disabled): specs written for the plain queues set this to switch the study order off. */
function testSwitchOff(): boolean {
  try {
    return localStorage.getItem('anan.study.disabled') === '1';
  } catch {
    return false;
  }
}

/** The registered study context (lexicon + books), for the ledger. */
export function peekStudyContext(): { lexicon: Lexicon; books: Textbook[] } | undefined {
  return ctx;
}

/** Load the profile's study settings (once). */
export function loadStudySettings(): Promise<void> {
  return load();
}

/** The study settings the ledger uses (the e2e switch turns the study order off). */
export function effectiveStudySettings(): StudySettings {
  return { ...settings, enabled: settings.enabled && !testSwitchOff() };
}

/** The study focus for the CURRENT state (the ledger's); undefined when there is no textbook. */
export async function getStudyFocusNow(now: Date = new Date()): Promise<StudyFocus | undefined> {
  if (!ctx || ctx.books.length === 0 || !currentSession()) return undefined;
  await load();
  // Off: nothing to order.
  if (!settings.enabled || testSwitchOff()) return disabledFocus();
  return (await getLedgerNow(now)).focus();
}

function disabledFocus(): StudyFocus {
  return {
    enabled: false,
    steps: [],
    activeStep: undefined,
    reviewLessons: [],
    focusItems: [],
    reviewItems: [],
    newItemsAllowed: [],
    generalNewItemsAllowed: true,
    gateStatus: { blocked: false },
    mastery: undefined,
    nextStep: undefined,
    reached: settings.reached,
    justMastered: [],
  };
}

export const getStudyBooks = (): Textbook[] => ctx?.books ?? [];

export const lessonIndexFor = (books: readonly Textbook[]) => lessonIndex(books);

/** Provider hook: keep the context registered. Mount once, high in the tree. */
export function useStudyContextRegistration(): void {
  const lex = useLexicon();
  const tb = useTextbook();
  useEffect(() => {
    if (lex.status === 'ready' && tb.status === 'ready') registerStudyContext({ lexicon: lex.lexicon, books: tb.books });
    else if (lex.status === 'ready' && tb.status === 'missing') registerStudyContext({ lexicon: lex.lexicon, books: [] });
  }, [lex, tb]);
}

export interface StudyState {
  focus: StudyFocus | undefined;
  books: Textbook[];
  /** Lessons that became mastered since the last screen (celebrate once, then dismiss). */
  celebrate: string[];
  dismissCelebration: () => void;
}

let pendingCelebrations: string[] = [];

/** The focus for a screen. Persists the (monotone) progress pointer when it advances. */
export function useStudyFocus(): StudyState {
  const [focus, setFocus] = useState<StudyFocus | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const set = useStudySettings();
  const tb = useTextbook();
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let cancelled = false;
    getStudyFocusNow().then((f) => {
      if (cancelled) return;
      setFocus(f);
      // Phase 21: class lessons the TOCFL gate held back join review once the gate opens.
      if (f?.enabled && ctx) void catchUpClassCoverage(ctx.books, learnerService, new Set(f.gatedLessonIds ?? [])).catch(() => 0);
      if (f && f.reached > settings.reached) {
        pendingCelebrations = [...pendingCelebrations, ...f.justMastered.map((s) => s.lessonId)];
        void updateStudySettings({ reached: f.reached });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tick, set]);
  const [, bump] = useState(0);
  return {
    focus: focus && set.enabled ? focus : focus ? { ...focus, enabled: false } : undefined,
    books: tb.status === 'ready' ? tb.books : [],
    celebrate: pendingCelebrations,
    dismissCelebration: () => {
      pendingCelebrations = [];
      bump((n) => n + 1);
    },
  };
}

/**
 * Phase 21 Part D: the class scope (visibility only: what is past the class is hidden), with the
 * ONE "Lessons ahead of class" setting. Priority never comes from here; it comes from the focus.
 */
export function currentClassScope(): ClassScope {
  return classScope(peekMyClass(), { aheadLessons: settings.classAheadLessons });
}
// Phase 29: the ledger reads the study context and settings from here.
setLedgerStudySource({
  load,
  inputs: () => {
    if (!ctx) return undefined;
    const my = peekMyClass();
    return {
      lexicon: ctx.lexicon,
      books: ctx.books,
      settings: effectiveStudySettings(),
      myClass: { enabled: my.enabled, textbookId: my.textbookId, currentLesson: my.currentLesson },
      classScope: currentClassScope(),
    };
  },
  knownItems: () => settings.knownItems,
  masteryShare: () => settings.masteryShare,
});

export function useClassScope(): ClassScope {
  const my = useMyClass();
  const set = useStudySettings();
  return classScope(my, { aheadLessons: set.classAheadLessons });
}
