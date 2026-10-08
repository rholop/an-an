import { useEffect, useState } from 'react';
import { ConfusableIndex, confusionsFromEvidence, levelIndex, type Lexicon, type Word } from '@anan/core';
import { db, learnerService, onSessionChange } from '../db/instance.js';
import { peekCurrentLevel } from './current-level.js';

/**
 * Phase 23: what the look-alike pickers need (Review's "Pick the Mandarin", the Pinyin & tones
 * tab): one index per lexicon, the learner's known / due / current-level words (plausible options)
 * and their past mix-ups (wrong picks). Loaded once per page visit.
 */
export interface ConfusableContext {
  index: ConfusableIndex;
  preferred: ReadonlySet<string>;
  confusions: ReadonlyMap<string, ReadonlySet<string>>;
}

const indexes = new WeakMap<Lexicon, ConfusableIndex>();
export function confusableIndex(lexicon: Lexicon): ConfusableIndex {
  let i = indexes.get(lexicon);
  if (!i) {
    i = new ConfusableIndex(lexicon.allWords());
    indexes.set(lexicon, i);
  }
  return i;
}

let cached: { lexicon: Lexicon; value: Promise<Omit<ConfusableContext, 'index'>> } | null = null;
onSessionChange(() => {
  cached = null;
});

async function loadLearnerSide(lexicon: Lexicon): Promise<Omit<ConfusableContext, 'index'>> {
  const now = new Date();
  const [sets, picks] = await Promise.all([
    learnerService.wordSets(now),
    db.evidence.filter((e) => typeof e.context?.pickedId === 'string').toArray(),
  ]);
  const li = levelIndex(peekCurrentLevel().level);
  const preferred = new Set<string>([...sets.knownIds, ...sets.dueIds, ...sets.learningIds]);
  // the current level's words are plausible too (never above it)
  if (li >= 0)
    for (const w of lexicon.allWords() as Word[]) if (w.source === 'tocfl' && w.level && levelIndex(w.level) === li) preferred.add(w.id);
  return { preferred, confusions: confusionsFromEvidence(picks) };
}

export function useConfusables(lexicon: Lexicon | null): ConfusableContext | null {
  const [value, setValue] = useState<ConfusableContext | null>(null);
  useEffect(() => {
    if (!lexicon) return;
    let cancelled = false;
    if (!cached || cached.lexicon !== lexicon) cached = { lexicon, value: loadLearnerSide(lexicon) };
    void cached.value
      .then((side) => !cancelled && setValue({ index: confusableIndex(lexicon), ...side }))
      .catch(() => !cancelled && setValue({ index: confusableIndex(lexicon), preferred: new Set(), confusions: new Map() }));
    return () => {
      cancelled = true;
    };
  }, [lexicon]);
  return value;
}

/** A new wrong pick joins the mix-ups for the rest of the visit. */
export function noteConfusion(ctx: ConfusableContext | null, a: string, b: string): void {
  if (!ctx) return;
  const m = ctx.confusions as Map<string, Set<string>>;
  m.set(a, new Set([...(m.get(a) ?? []), b]));
  m.set(b, new Set([...(m.get(b) ?? []), a]));
}
