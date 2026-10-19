import { useEffect, useState } from 'react';
import {
  confusableIndexFor,
  confusionsFromEvidence,
  LEVEL_IDS,
  levelIndex,
  type ConfusableIndex,
  type DistractorTable,
  type Level,
  type Lexicon,
  type Word,
} from '@anan/core';
import { db, learnerService, onSessionChange } from '../db/instance.js';
import { peekCurrentLevel } from './current-level.js';
import { dataUrl, onDataFilesChanged } from './data-files.js';

/**
 * Phase 23 / Phase 48: what every choice exercise needs (Review's "Pick the Mandarin", Cloze, the
 * Pinyin & tones tab): one index per lexicon with the offline candidate table
 * (`lexicon/distractors.v1.json`), the learner's known / due / current-level words (plausible
 * options), their level + 1 (the highest level of an option they haven't met) and their past
 * mix-ups (wrong picks). Loaded once per page visit. Tutoring and custom words are in the lexicon
 * the moment they are saved, and the index finds their candidates from the same code axes (Part C).
 */
export interface ConfusableContext {
  index: ConfusableIndex;
  preferred: ReadonlySet<string>;
  confusions: ReadonlyMap<string, ReadonlySet<string>>;
  /** Phase 48 B.4: the learner's level + 1. */
  levelCap?: Level;
}

export const DISTRACTORS_FILE = 'lexicon/distractors.v1.json';

let table: Promise<DistractorTable | undefined> | null = null;
function loadTable(): Promise<DistractorTable | undefined> {
  table ??= (async () => {
    try {
      const res = await fetch(await dataUrl(DISTRACTORS_FILE));
      return res.ok ? ((await res.json()) as DistractorTable) : undefined;
    } catch {
      table = null; // offline before it was ever cached: the code axes alone until next time
      return undefined;
    }
  })();
  return table;
}
onDataFilesChanged((changed) => {
  if (changed.includes(DISTRACTORS_FILE)) table = null;
});

/** The lexicon's index (shared with core's Cloze and Listening builders), with the table once loaded. */
export function confusableIndex(lexicon: Lexicon): ConfusableIndex {
  return confusableIndexFor(lexicon);
}

/** The learner's level + 1 (options they haven't met go no higher). */
export function optionLevelCap(): Level {
  const li = levelIndex(peekCurrentLevel().level);
  return LEVEL_IDS[Math.min(Math.max(li, 0) + 1, LEVEL_IDS.length - 1)]!;
}

let cached: { lexicon: Lexicon; value: Promise<Omit<ConfusableContext, 'index'>> } | null = null;
onSessionChange(() => {
  cached = null;
});

async function loadLearnerSide(lexicon: Lexicon): Promise<Omit<ConfusableContext, 'index'>> {
  const now = new Date();
  const [ledger, picks, t] = await Promise.all([
    learnerService.ledger(now),
    db.evidence.filter((e) => typeof e.context?.pickedId === 'string').toArray(),
    loadTable(),
  ]);
  const index = confusableIndexFor(lexicon);
  if (t) index.setTable(t);
  const li = levelIndex(peekCurrentLevel().level);
  const preferred = new Set<string>(ledger.comprehensible().ids);
  // the current level's words are plausible too (never above it)
  if (li >= 0)
    for (const w of lexicon.allWords() as Word[]) if (w.source === 'tocfl' && w.level && levelIndex(w.level) === li) preferred.add(w.id);
  return { preferred, confusions: confusionsFromEvidence(picks), levelCap: optionLevelCap() };
}

export function useConfusables(lexicon: Lexicon | null): ConfusableContext | null {
  const [value, setValue] = useState<ConfusableContext | null>(null);
  useEffect(() => {
    if (!lexicon) return;
    let cancelled = false;
    if (!cached || cached.lexicon !== lexicon) cached = { lexicon, value: loadLearnerSide(lexicon) };
    void cached.value
      .then((side) => !cancelled && setValue({ index: confusableIndex(lexicon), ...side }))
      .catch(() => !cancelled && setValue({ index: confusableIndex(lexicon), preferred: new Set(), confusions: new Map(), levelCap: optionLevelCap() }));
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
