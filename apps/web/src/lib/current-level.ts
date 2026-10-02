import { useSyncExternalStore } from 'react';
import { currentFrontierLevel, isLevel, LEVEL_IDS, type Level, type Lexicon } from '@anan/core';
import { allTouchedCards } from '../db/queries.js';
import { currentSession, db, onSessionChange } from '../db/instance.js';

/**
 * Phase 7: "My level" — ONE global setting (`settings.currentLevel`) that every
 * feature reads through `useCurrentLevel()`. A tiny external store keeps all
 * mounted components in sync the moment it changes (no reload), and Dexie
 * keeps it across sessions. Set by the placement test, the header picker, or
 * the level-up prompt; never changed automatically.
 */
const KEY = 'currentLevel';
const DEFAULT_LEVEL: Level = LEVEL_IDS[0]!;

let current: Level = DEFAULT_LEVEL;
let explicit = false;
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

async function load(): Promise<void> {
  if (loaded || !currentSession()) return;
  loaded = true;
  const forProfile = currentSession()!.profileId;
  let row;
  try {
    row = await db.settings.get(KEY);
  } catch {
    return; // the profile's database was closed while we were reading (switched/closed)
  }
  if (currentSession()?.profileId !== forProfile) return; // switched while loading
  if (isLevel(row?.value)) {
    current = row.value;
    explicit = true;
  }
  notify();
}

// Phase 8: "My level" is per profile. Switching profile forgets the previous
// person's choice and reads the new profile's own (or starts from their progress).
onSessionChange((session) => {
  current = DEFAULT_LEVEL;
  explicit = false;
  loaded = false;
  notify();
  if (session) void load();
});

/** Persist + broadcast. */
export async function setCurrentLevel(level: Level): Promise<void> {
  current = level;
  explicit = true;
  loaded = true;
  notify();
  await db.settings.put({ key: KEY, value: level });
}

/** First run only: no explicit choice yet, so start where progress says the
 * learner is (the Phase 2 frontier) instead of N1, and persist it. */
export async function initCurrentLevelIfUnset(lexicon: Lexicon): Promise<void> {
  await load();
  if (explicit) return;
  const cards = await allTouchedCards(db);
  const derived = currentFrontierLevel(
    lexicon.allWords(),
    cards.filter((c) => c.skill === 'recognition'),
  );
  await setCurrentLevel(derived);
}

/** Test hook: forget the module state (the DB is wiped separately). */
export function resetCurrentLevelForTests(): void {
  current = DEFAULT_LEVEL;
  explicit = false;
  loaded = false;
  notify();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export interface CurrentLevel {
  level: Level;
  /** False until the learner (or placement) has chosen / first-run init ran. */
  isExplicit: boolean;
  setLevel: (level: Level) => Promise<void>;
}

export function useCurrentLevel(): CurrentLevel {
  const level = useSyncExternalStore(subscribe, () => current);
  const isExplicit = useSyncExternalStore(subscribe, () => explicit);
  return { level, isExplicit, setLevel: setCurrentLevel };
}

/** After a sync merge replaced the database contents: re-read the setting. */
export function reloadCurrentLevel(): void {
  loaded = false;
  explicit = false;
  void load();
}

/** For tests/diagnostics: the store's current value without React. */
export function peekCurrentLevel(): { level: Level; isExplicit: boolean } {
  return { level: current, isExplicit: explicit };
}
