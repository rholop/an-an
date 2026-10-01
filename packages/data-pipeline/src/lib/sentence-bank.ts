import type { AnalyzeContext, Level, Word } from '@anan/core';

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Headwords at/below `word`'s level for the model to compose with (phase
 * doc 04 §1), capped to a manageable prompt size: the guaranteed core
 * fillers (if present at this level) plus a random sample of the rest. */
export function sampleAllowedVocab(
  word: Word,
  atOrBelowLevelPool: Word[],
  coreFillers: readonly string[],
  sampleSize: number,
  rng: () => number,
): string[] {
  const fillers = atOrBelowLevelPool.filter((w) => w.id !== word.id && coreFillers.includes(w.headword)).map((w) => w.headword);
  const rest = atOrBelowLevelPool.filter((w) => w.id !== word.id && !fillers.includes(w.headword));
  const sampledRest = shuffle(rest, rng)
    .slice(0, Math.max(0, sampleSize - fillers.length))
    .map((w) => w.headword);
  return [...new Set([...fillers, ...sampledRest])];
}

export function buildAnalyzeContext(word: Word, lexicon: AnalyzeContext['lexicon'], allowedVocabIds: ReadonlySet<string>): AnalyzeContext {
  return {
    lexicon,
    learnerLevel: word.level ?? ('L6' as Level),
    knownIds: allowedVocabIds,
    dueIds: new Set(),
    targetIds: new Set([word.id]),
    learningIds: new Set(),
    allowedExtraIds: new Set(),
  };
}

/** "A second-pass check (a different model call or rules) for naturalness;
 * flag doubtful ones" (phase doc 04 §1) — rules, not a second model call:
 * suspiciously short/long sentences for a cloze exercise are the cheap,
 * reliable signal worth flagging for a human to glance at. */
export function isDoubtful(zh: string): boolean {
  const len = [...zh].length;
  return len < 4 || len > 30;
}
