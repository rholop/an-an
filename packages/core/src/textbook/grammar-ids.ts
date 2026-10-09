import type { ItemRef } from '../types.js';

/**
 * Phase 25 B8: grammar ids that named two different patterns across books are split. An answer
 * given in a later book's lesson (its lesson id or sentence id names that book) moves to the new
 * id; everything else keeps the old one.
 *
 * Ids kept shared on purpose (the pattern really is the same, so progress is shared): `gram-yihou`
 * (event 1 + 以後 + event 2, book 1 L7, taught again in book 3 L1).
 */
export const GRAMMAR_ID_SPLITS: ReadonlyArray<{ from: string; to: string; books: readonly string[] }> = [
  // 從 + place + 到 + place (book 2 L6) vs 從 + time + 到 + time (book 3 L3)
  { from: 'gram-cong-dao', to: 'gram-cong-dao-time', books: ['laixue-3', 'laixue-4'] },
];

const bookOfRef = (refId: string | undefined): string | undefined => {
  if (!refId) return undefined;
  const lesson = /laixue-(\d+)/.exec(refId);
  if (lesson) return `laixue-${lesson[1]}`;
  const sentence = /^tb-b(\d+)-/.exec(refId);
  return sentence ? `laixue-${sentence[1]}` : undefined;
};

/** The evidence row with its grammar id split (unchanged when no split applies). */
export function splitGrammarEvidence<T extends { item: ItemRef; context?: { refId?: string } }>(e: T): T {
  if (e.item.kind !== 'grammar') return e;
  const split = GRAMMAR_ID_SPLITS.find((s) => s.from === e.item.id);
  const book = bookOfRef(e.context?.refId);
  if (!split || !book || !split.books.includes(book)) return e;
  return { ...e, item: { kind: 'grammar', id: split.to } };
}
