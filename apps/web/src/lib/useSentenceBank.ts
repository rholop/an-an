import { useEffect, useState } from 'react';
import { SentenceBankFileSchema, type Level, type SentenceBankEntry } from '@anan/core';

export type SentenceBankLoadState =
  | { status: 'loading' }
  | { status: 'ready'; sentences: SentenceBankEntry[] };

/** Lazy-loads the sentence bank for exactly the levels requested (phase doc
 * 04 §1: "lazy-loaded per level"), mirroring useLexicon/useScenarios. A
 * level with no generated file yet (pre-launch, or before a real LLM run —
 * see packages/data-pipeline/src/build-sentences.ts) is treated as "no
 * sentences for that level" rather than an error: the cloze session just
 * falls back further down phase doc §2's source priority. */
export function useSentenceBank(levels: Level[]): SentenceBankLoadState {
  const key = [...new Set(levels)].sort().join(',');
  const [state, setState] = useState<SentenceBankLoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const wanted = key ? key.split(',') : [];

    Promise.all(
      wanted.map(async (level) => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}sentences/sentences.v1.${level}.json`);
          if (!res.ok) return [];
          return SentenceBankFileSchema.parse(await res.json()).sentences;
        } catch {
          return [];
        }
      }),
    ).then((lists) => {
      if (cancelled) return;
      setState({ status: 'ready', sentences: lists.flat() });
    });

    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}
