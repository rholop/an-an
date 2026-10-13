// Phase 38 Part A: the app's data files (lexicon, scenarios, sentence banks, textbook) under their
// content-hashed names. `public/data-manifest.json` (written by the sync scripts) maps each plain
// name to the current hashed one. The manifest is always fetched fresh (no-cache; the service
// worker falls back to its copy offline), the hashed files may be cached forever: a new build is a
// new URL, so the word list and the book always come from the same build.

/** The manifest as the sync scripts write it. */
export interface DataManifest {
  version: number;
  files: Record<string, string>;
}

const MANIFEST_URL = () => `${import.meta.env.BASE_URL}data-manifest.json`;
/** The service worker's cache for the hashed data files (vite.config.ts). */
export const DATA_CACHE = 'anan-data-cache';
const PREVIOUS_KEY = 'anan.dataManifest.previous';

let current: Promise<DataManifest | null> | null = null;
let known: DataManifest | null = null;
const listeners = new Set<(changed: string[]) => void>();

async function fetchManifest(fresh: 'no-cache' | 'reload'): Promise<DataManifest | null> {
  try {
    const res = await fetch(MANIFEST_URL(), { cache: fresh });
    if (!res.ok) return null;
    const m = (await res.json()) as Partial<DataManifest>;
    return m && typeof m.files === 'object' && m.files ? { version: m.version ?? 1, files: m.files } : null;
  } catch {
    return null; // offline with no cached copy, or a dev server without the sync scripts' output
  }
}

/** The current manifest (fetched once per visit, then by `checkForDataUpdate`). Null without one. */
export function loadManifest(): Promise<DataManifest | null> {
  current ??= fetchManifest('no-cache').then((m) => {
    if (m) {
      known = m;
      void pruneDataCache(m);
    }
    return m;
  });
  return current;
}

/** The URL of a data file by its plain name ("lexicon/lexicon.v2.json"): the hashed one when the
 * manifest lists it, else the plain one (dev without a manifest). */
export async function dataUrl(logical: string): Promise<string> {
  const m = await loadManifest();
  return `${import.meta.env.BASE_URL}${m?.files[logical] ?? logical}`;
}

/** Hears the plain names whose hashed file changed after a manifest check. */
export function onDataFilesChanged(listener: (changed: string[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Fetches the manifest again (bypassing every cache with `reload`) and tells listeners which files
 * changed. The new files are then loaded in the background; no page reload is needed.
 */
export async function checkForDataUpdate(opts: { reload?: boolean } = {}): Promise<string[]> {
  const next = await fetchManifest(opts.reload ? 'reload' : 'no-cache');
  if (!next) return [];
  const before = known;
  known = next;
  current = Promise.resolve(next);
  const changed = Object.keys({ ...next.files, ...(before?.files ?? {}) }).filter((k) => before?.files[k] !== next.files[k]);
  if (before && changed.length > 0) {
    rememberPrevious(before);
    void pruneDataCache(next);
    listeners.forEach((l) => l(changed));
  }
  return before ? changed : [];
}

function rememberPrevious(m: DataManifest): void {
  try {
    localStorage.setItem(PREVIOUS_KEY, JSON.stringify(m));
  } catch {
    /* private mode: the previous build's files are pruned a visit earlier, that's all */
  }
}

function previousManifest(): DataManifest | null {
  try {
    const raw = localStorage.getItem(PREVIOUS_KEY);
    return raw ? (JSON.parse(raw) as DataManifest) : null;
  } catch {
    return null;
  }
}

/** Keep only the current and previous builds' hashed files in the service worker's data cache. */
export async function pruneDataCache(m: DataManifest): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    if (!(await caches.has(DATA_CACHE))) return;
    const keep = new Set([...Object.values(m.files), ...Object.values(previousManifest()?.files ?? {})]);
    const cache = await caches.open(DATA_CACHE);
    const base = new URL(import.meta.env.BASE_URL, location.href).pathname;
    for (const req of await cache.keys()) {
      const rel = new URL(req.url).pathname.slice(base.length);
      // older builds, and plain-name copies an earlier service worker cached (Phase 11 to 37)
      if (!keep.has(rel)) await cache.delete(req);
    }
  } catch {
    /* the cache is an optimisation */
  }
}

/** Check the manifest whenever the app comes back to the foreground, and every half hour. */
let watching = false;
export function watchDataUpdates(intervalMs = 30 * 60_000): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForDataUpdate();
  });
  setInterval(() => void checkForDataUpdate(), intervalMs);
}

/** Tests: forget the loaded manifest. */
export function resetDataFilesForTests(): void {
  current = null;
  known = null;
}
