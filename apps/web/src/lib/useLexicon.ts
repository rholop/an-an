import { useEffect, useState } from 'react';
import { Lexicon, type GrammarItem, type Word } from '@anan/core';
import { db } from '../db/instance.js';

interface LexiconFile {
  meta: { version: string; buildDate: string; wordCount: number };
  words: Word[];
  grammar: GrammarItem[];
}

export type LexiconLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; lexicon: Lexicon; meta: LexiconFile['meta'] };

const LEXICON_URL = () => `${import.meta.env.BASE_URL}lexicon/lexicon.v2.json`;

// The file is ~2.9 MB gzipped / 18 MB parsed. It is fetched and parsed ONCE per
// visit and shared: the header and the current page both ask for it, and every
// tab switch used to download (from cache) and parse it again.
let filePromise: Promise<LexiconFile> | null = null;
let built: { key: string; lexicon: Lexicon; meta: LexiconFile['meta'] } | null = null;

/** Starts the download. Called from main.tsx so it runs while the app's own JS
 * is still being parsed (index.html also preloads the same URL). */
export function preloadLexicon(): Promise<LexiconFile> {
  filePromise ??= fetch(LEXICON_URL())
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<LexiconFile>;
    })
    .catch((err: unknown) => {
      filePromise = null; // let a later mount retry
      throw err;
    });
  return filePromise;
}

const customKey = (words: readonly Word[]) =>
  words.map((w) => `${w.id}:${(w as { updatedAt?: Date }).updatedAt?.getTime() ?? 0}`).join('|');

/** Fetches the built lexicon (see apps/web/scripts/sync-lexicon.mjs), merges
 * in any user-added custom words (Anki import's unmatched-row path — Phase 2
 * §6), and wraps the combination in a core Lexicon instance. Custom words are
 * re-read each time a component mounts this hook, so switching tabs after an
 * import picks them up; the Lexicon is only rebuilt when they changed. */
export function useLexicon(): LexiconLoadState {
  const [state, setState] = useState<LexiconLoadState>(() =>
    built ? { status: 'ready', lexicon: built.lexicon, meta: built.meta } : { status: 'loading' },
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([preloadLexicon(), db.customWords.toArray()])
      .then(([data, customWords]) => {
        if (cancelled) return;
        const key = customKey(customWords);
        if (!built || built.key !== key) {
          built = {
            key,
            lexicon: new Lexicon([...data.words, ...customWords], data.grammar),
            meta: data.meta,
          };
        }
        const b = built;
        setState((prev) =>
          prev.status === 'ready' && prev.lexicon === b.lexicon
            ? prev
            : { status: 'ready', lexicon: b.lexicon, meta: b.meta },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
