// Phase 47 Part B (owner, 2026-10-18: "it keeps asking me to replace english words but I haven't
// learned or mastered them yet"): a journal fix is shown only when the learner can answer it, i.e.
// every word in its answer is comprehensible (Learned, in session or learning). Until then it waits.

import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import type { ErrorItem } from './types.js';

/** What the learner must produce: the corrected text in the blank (empty for a deletion). */
export function errorAnswerText(item: Pick<ErrorItem, 'original' | 'corrected' | 'span'> & { blank?: [number, number] }): string {
  const [start, end] = item.blank ?? [item.span[0], item.corrected.length - (item.original.length - item.span[1])];
  return item.corrected.slice(start, end);
}

/** The words the learner knows (the ledger's comprehensible ids) and the lexicon to find them. */
export interface AnswerKnown {
  lexicon: Lexicon;
  ids: ReadonlySet<string>;
}

type AnswerFields = Partial<Pick<ErrorItem, 'original' | 'corrected' | 'span' | 'itemRef'>> & { blank?: [number, number] };

/**
 * The words of the item's answer the learner doesn't know yet (one id per word, the item's own word
 * when it names one). A word counts as known when any sense of it is comprehensible. Text the
 * lexicon has no word for (punctuation, names, Latin) never holds an item back.
 */
export function unknownAnswerWords(item: AnswerFields, known: AnswerKnown): string[] {
  if (item.original === undefined || item.corrected === undefined || !item.span) return [];
  const answer = errorAnswerText({ original: item.original, corrected: item.corrected, span: item.span, ...(item.blank ? { blank: item.blank } : {}) });
  if (!answer.trim()) return [];
  const out: string[] = [];
  for (const t of segment(answer, known.lexicon)) {
    if (t.kind !== 'word') continue;
    const senses = known.lexicon.lookup(t.text);
    if (senses.length === 0 || senses.some((w) => known.ids.has(w.id))) continue;
    const own = item.itemRef?.kind === 'word' ? senses.find((w) => w.id === item.itemRef!.id) : undefined;
    const id = (own ?? senses[0]!).id;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
