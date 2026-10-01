import { useEffect, useState } from 'react';
import { Lexicon, type GrammarItem, type Word } from '@anan/core';

interface LexiconFile {
  meta: { version: string; buildDate: string; wordCount: number };
  words: Word[];
  grammar: GrammarItem[];
}

export type LexiconLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; lexicon: Lexicon; meta: LexiconFile['meta'] };

/** Fetches the built lexicon (see apps/web/scripts/sync-lexicon.mjs) and
 * wraps it in a core Lexicon instance. Loaded once per app session — Phase 1
 * has no persistence layer yet (Phase 2). */
export function useLexicon(): LexiconLoadState {
  const [state, setState] = useState<LexiconLoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/lexicon/lexicon.v1.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<LexiconFile>;
      })
      .then((data) => {
        if (cancelled) return;
        const lexicon = new Lexicon(data.words, data.grammar);
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
