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

/** Fetches the built lexicon (see apps/web/scripts/sync-lexicon.mjs), merges
 * in any user-added custom words (Anki import's unmatched-row path — Phase 2
 * §6), and wraps the combination in a core Lexicon instance. Re-reads custom
 * words fresh each time a component mounts this hook, so switching tabs
 * after an import picks up new custom words without a full reload. */
export function useLexicon(): LexiconLoadState {
  const [state, setState] = useState<LexiconLoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}lexicon/lexicon.v2.json`).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<LexiconFile>;
      }),
      db.customWords.toArray(),
    ])
      .then(([data, customWords]) => {
        if (cancelled) return;
        const lexicon = new Lexicon([...data.words, ...customWords], data.grammar);
        setState({ status: 'ready', lexicon, meta: data.meta });
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
