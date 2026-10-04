import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_STUDY_SETTINGS,
  getStudyFocus,
  grammarUsesFromEvidence,
  lessonIndex,
  PRIORITY_CONFIG,
  type Lexicon,
  type StudyFocus,
  type StudySettings,
  type Textbook,
} from '@anan/core';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import { allTouchedCards } from '../db/queries.js';
import { peekMyClass } from './my-class.js';
import { markStudyDirty, onStudyDirty, studyVersion } from './study-dirty.js';
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
  cache = undefined;
  notify();
  if (session) void load();
});

/** After a sync merge replaced the database contents. */
export function reloadStudySettings(): void {
  loaded = false;
  cache = undefined;
  void load();
}

export function peekStudySettings(): StudySettings {
  return settings;
}

export async function updateStudySettings(patch: Partial<StudySettings>): Promise<void> {
  settings = sanitize({ ...settings, ...patch });
  loaded = true;
  cache = undefined;
  notify();
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
  cache = undefined;
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

let cache: { version: number; focus: Promise<StudyFocus | undefined> } | undefined;

/** The study focus for the CURRENT state; undefined when there is no textbook (study order has nothing to order). */
export function getStudyFocusNow(now: Date = new Date()): Promise<StudyFocus | undefined> {
  if (!ctx || ctx.books.length === 0 || !currentSession()) return Promise.resolve(undefined);
  if (cache && cache.version === studyVersion()) return cache.focus;
  const c = ctx;
  const version = studyVersion();
  const focus = (async () => {
    await load();
    // Off: nothing to compute (and no heavy work on every screen).
    if (!settings.enabled || testSwitchOff()) return disabledFocus();
    const [cards, evidence] = await Promise.all([
      allTouchedCards(db),
      db.evidence.where('kind').anyOf([...PRIORITY_CONFIG.grammarCorrectKinds, ...PRIORITY_CONFIG.grammarWrongKinds]).toArray().catch(() => db.evidence.toArray()),
    ]);
    const my = peekMyClass();
    const effective = { ...settings, enabled: settings.enabled && !testSwitchOff() };
    return getStudyFocus(
      {
        lexicon: c.lexicon,
        books: c.books,
        cards,
        grammarUses: grammarUsesFromEvidence(evidence),
        settings: effective,
        myClass: { enabled: my.enabled, textbookId: my.textbookId, currentLesson: my.currentLesson },
      },
      now,
    );
  })();
  cache = { version, focus };
  return focus;
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
