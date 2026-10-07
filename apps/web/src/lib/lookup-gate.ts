import { useEffect } from 'react';
import { lookupMayIntroduce, type Lexicon } from '@anan/core';
import { peekCurrentLevel } from './current-level.js';
import { setLookupGate } from './learner-service.js';
import { useLexicon } from './useLexicon.js';

/**
 * Phase 20: a lookup creates a card on its own only for words in bounds (TOCFL up to the picked
 * level + 1, textbook and the learner's own words). Words not in the lexicon (custom words
 * being added) are let through.
 */
export function lookupGateFor(lexicon: Lexicon, level: () => ReturnType<typeof peekCurrentLevel>['level'] | undefined) {
  return (wordId: string): boolean => {
    const w = lexicon.byId(wordId);
    return !w || lookupMayIntroduce(w, level());
  };
}

/** Mount once, high in the tree. */
export function useLookupGateRegistration(): void {
  const lex = useLexicon();
  useEffect(() => {
    if (lex.status !== 'ready') return;
    setLookupGate(lookupGateFor(lex.lexicon, () => peekCurrentLevel().level));
    return () => setLookupGate(undefined);
  }, [lex]);
}
