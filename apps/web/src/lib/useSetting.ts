import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import { registerAfterMerge, registerBeforeSwitch } from './profile-controller.js';

/**
 * A setting stored in the CURRENT profile's database (`settings` table), so
 * display mode, scaffolding, drafts etc. are per person. Writes through, and
 * registers a before-switch flush, so a value changed a moment ago — or a
 * half-written journal draft — is saved before the other profile opens.
 *
 * Phase 21: every hook with the same key shares ONE store (two components can no
 * longer disagree about a setting), the store is cleared on a profile switch and
 * re-read after a sync merge (`reloadSettings`).
 */
interface Entry {
  value: unknown;
  loaded: boolean;
  dirty: boolean;
  loading?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  snapshot: [unknown, boolean];
}

const store = new Map<string, Entry>();
/** Listeners per key (they outlive a store reset on profile switch). */
const listeners = new Map<string, Set<() => void>>();

function entry(key: string, fallback: unknown): Entry {
  let e = store.get(key);
  if (!e) {
    e = { value: fallback, loaded: false, dirty: false, snapshot: [fallback, false] };
    store.set(key, e);
  }
  return e;
}

function notifyKey(key: string): void {
  listeners.get(key)?.forEach((l) => l());
}

function emit(key: string, e: Entry): void {
  e.snapshot = [e.value, e.loaded];
  notifyKey(key);
}

function load(key: string, e: Entry): void {
  if (e.loaded || e.loading || !currentSession()) return;
  const forProfile = currentSession()!.profileId;
  e.loading = db.settings
    .get(key)
    .then((row) => {
      if (currentSession()?.profileId !== forProfile || store.get(key) !== e) return;
      if (row && row.value !== undefined && !e.dirty) e.value = row.value;
      e.loaded = true;
      emit(key, e);
    })
    .catch(() => {
      e.loaded = true;
      emit(key, e);
    })
    .finally(() => {
      e.loading = undefined;
    });
}

async function write(key: string): Promise<void> {
  const e = store.get(key);
  if (!e) return;
  clearTimeout(e.timer);
  if (!e.dirty) return;
  e.dirty = false;
  await db.settings.put({ key, value: e.value });
}

/** Flush every pending write (before a profile switch). */
async function flushAll(): Promise<void> {
  await Promise.all([...store.keys()].map((k) => write(k)));
}

let flushRegistered = false;

onSessionChange(() => {
  // A different profile: nothing from the previous one may show.
  for (const e of store.values()) clearTimeout(e.timer);
  const keys = [...store.keys()];
  store.clear();
  keys.forEach(notifyKey);
});

/** After a sync merge replaced the database contents: re-read every setting in use. */
export function reloadSettings(): void {
  for (const [key, e] of store) {
    if (e.dirty) continue;
    e.loaded = false;
    load(key, e);
  }
}
registerAfterMerge(reloadSettings);

/** Read a setting outside React (e.g. before acting on it). Waits for the first load. */
export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const e = entry(key, fallback);
  load(key, e);
  await e.loading;
  return e.value as T;
}

export function useSetting<T>(
  key: string,
  fallback: T,
  debounceMs = 0,
): [T, (v: T) => void, boolean] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        listeners.get(key)?.delete(cb);
      };
    },
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, () => entry(key, fallback).snapshot);
  useEffect(() => {
    load(key, entry(key, fallback));
  }, [key, snapshot]);

  useEffect(() => {
    if (flushRegistered) return;
    flushRegistered = true;
    registerBeforeSwitch(flushAll);
  }, []);

  const set = useCallback(
    (v: T) => {
      const e = entry(key, fallback);
      e.value = v;
      e.dirty = true;
      e.loaded = true;
      emit(key, e);
      // typed text (drafts) is written after a short pause; everything else at once
      clearTimeout(e.timer);
      if (debounceMs > 0) e.timer = setTimeout(() => void write(key), debounceMs);
      else void write(key);
    },
    [key, debounceMs],
  );

  return [snapshot[0] as T, set, snapshot[1]];
}
