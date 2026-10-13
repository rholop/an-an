import { useEffect, useState } from 'react';
import { Lexicon, type GrammarItem, type Word } from '@anan/core';
import { currentSession, onSessionChange, type Session } from '../db/instance.js';
import { checkForDataUpdate, dataUrl, onDataFilesChanged } from './data-files.js';
import { onStudyDirty } from './study-dirty.js';

interface LexiconFile {
  meta: { version: string; buildDate: string; wordCount: number };
  words: Word[];
  grammar: GrammarItem[];
}

export type LexiconLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; lexicon: Lexicon; meta: LexiconFile['meta'] };

/** The plain name; the URL is its content-hashed name from the data manifest (Phase 38). */
export const LEXICON_FILE = 'lexicon/lexicon.v2.json';

// The file is ~2.9 MB gzipped / 18 MB parsed. It is fetched and parsed ONCE per
// visit and shared: the header and the current page both ask for it, and every
// tab switch used to download (from cache) and parse it again.
let filePromise: Promise<LexiconFile> | null = null;
let built: { key: string; file: LexiconFile; lexicon: Lexicon; meta: LexiconFile['meta'] } | null = null;
let state: LexiconLoadState = { status: 'loading' };
const listeners = new Set<(s: LexiconLoadState) => void>();

function publish(next: LexiconLoadState): void {
  state = next;
  listeners.forEach((l) => l(next));
}

async function fetchLexicon(cache: RequestCache = 'default'): Promise<LexiconFile> {
  const res = await fetch(await dataUrl(LEXICON_FILE), { cache });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LexiconFile;
}

/** Starts the download. Called from main.tsx so it runs while the app's own JS
 * is still being parsed. */
export function preloadLexicon(): Promise<LexiconFile> {
  filePromise ??= fetchLexicon().catch((err: unknown) => {
    filePromise = null; // let a later mount retry
    throw err;
  });
  return filePromise;
}

const customKey = (words: readonly Word[]) =>
  words.map((w) => `${w.id}:${(w as { updatedAt?: Date }).updatedAt?.getTime() ?? 0}`).join('|');

async function readCustomWords(): Promise<Word[]> {
  const session = currentSession();
  if (!session) return [];
  watchCustomWords(session);
  return (await session.db.customWords.toArray()) as Word[];
}

/**
 * Builds (or keeps) the shared Lexicon: the built file plus the profile's custom words (Anki import's
 * unmatched rows, journal and chat gap words). Rebuilt only when the file or the custom words change.
 */
let building: Promise<void> | null = null;
let again = false;
function rebuild(): Promise<void> {
  if (building) {
    again = true;
    return building;
  }
  building = (async () => {
    do {
      again = false;
      try {
        const [file, customWords] = await Promise.all([preloadLexicon(), readCustomWords()]);
        const key = customKey(customWords);
        if (!built || built.key !== key || built.file !== file) {
          built = { key, file, lexicon: new Lexicon([...file.words, ...customWords], file.grammar), meta: file.meta };
        }
        if (state.status !== 'ready' || state.lexicon !== built.lexicon)
          publish({ status: 'ready', lexicon: built.lexicon, meta: built.meta });
      } catch (err) {
        if (state.status !== 'ready') publish({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    } while (again);
  })().finally(() => {
    building = null;
  });
  return building;
}

// Phase 21: a profile's custom words never leak into the next profile's lexicon (the parsed
// file itself is shared; only the built lexicon is dropped).
onSessionChange(() => {
  built = null;
  if (state.status === 'ready') state = { status: 'loading' };
  if (listeners.size > 0) void rebuild();
});

// Phase 38 Part C: a custom word added on this device (a journal or chat gap, an Anki import) or
// merged in by a sync shows up at once, without remounting the page that uses the lexicon.
const watchedDbs = new WeakSet<object>();
let customQueued = false;
function customChanged(): void {
  if (customQueued) return;
  customQueued = true;
  setTimeout(() => {
    customQueued = false;
    if (listeners.size > 0 || built) void rebuild();
  }, 0);
}
function watchCustomWords(session: Session): void {
  if (watchedDbs.has(session.db)) return;
  watchedDbs.add(session.db);
  const table = session.db.customWords;
  table.hook('creating', customChanged);
  table.hook('updating', customChanged);
  table.hook('deleting', customChanged);
}
// A sync merge writes without hooks; it marks the study state dirty, so re-read the custom words then.
onStudyDirty(customChanged);

// Phase 38 Part A.3: a new build while the app is open: load the new word list in the background,
// then swap the Lexicon in. No reload, no "update available" prompt.
onDataFilesChanged((changed) => {
  if (!changed.includes(LEXICON_FILE)) return;
  const next = fetchLexicon();
  next
    .then(() => {
      filePromise = next;
      return rebuild();
    })
    .catch(() => undefined); // offline: keep the word list we have
});

/**
 * Phase 38 Part B.3 / B.4: fetch the manifest and the word list again, bypassing caches (Review's
 * "Reload", and once at start-up when cards are waiting). Resolves when the new Lexicon is in.
 */
export async function reloadLexicon(): Promise<Lexicon | undefined> {
  await checkForDataUpdate({ reload: true });
  try {
    const file = await fetchLexicon('reload');
    filePromise = Promise.resolve(file);
    await rebuild();
  } catch {
    /* offline: the word list we have stays */
  }
  return state.status === 'ready' ? state.lexicon : undefined;
}

/** The current Lexicon (loading it if needed). */
export async function currentLexicon(): Promise<Lexicon | undefined> {
  if (state.status !== 'ready') await rebuild();
  return state.status === 'ready' ? (state as Extract<LexiconLoadState, { status: 'ready' }>).lexicon : undefined;
}

/** Fetches the built lexicon (see apps/web/scripts/sync-lexicon.mjs), merges in the profile's
 * custom words, and wraps the combination in a core Lexicon instance. Every user of the hook sees
 * the same instance, and a new one when the word list or the custom words change. */
export function useLexicon(): LexiconLoadState {
  const [s, setS] = useState<LexiconLoadState>(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    void rebuild();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

/** Tests: forget the loaded word list. */
export function resetLexiconForTests(): void {
  filePromise = null;
  built = null;
  state = { status: 'loading' };
}
