import { errorBlankSpan } from './error-bank.js';
import { normaliseAnswer } from './normalize.js';
import type { ErrorItem } from './types.js';

/** Phase 17 Part E: items from before the rebuild (no `version: 2`). */
export const isLegacyErrorItem = (i: Pick<ErrorItem, 'version'>): boolean => i.version !== 2;

/** What the old one-span-patched item blanked (used to carry its schedule over). */
export function legacyAnswer(item: ErrorItem): string {
  const [a, b] = errorBlankSpan(item);
  return item.corrected.slice(a, b);
}

const sameSentence = (oldItem: ErrorItem, next: ErrorItem) =>
  oldItem.original.includes(next.original) || next.original.includes(oldItem.original);

/** Is `next` testing the same word as the old item? The same lexicon item, or
 * the same answer text. */
export function testsSameWord(oldItem: ErrorItem, next: ErrorItem): boolean {
  if (!sameSentence(oldItem, next)) return false;
  if (oldItem.itemRef && next.itemRef && oldItem.itemRef.id === next.itemRef.id) return true;
  const old = normaliseAnswer(legacyAnswer(oldItem));
  if (!old) return false;
  const ex = next.exercise;
  const answers = [ex?.answer, ...(ex?.accepted ?? [])].filter((a): a is string => !!a);
  return answers.some((a) => normaliseAnswer(a) === old);
}

export interface RebuildOutcome {
  /** The rebuilt items, with the old schedule where the tested word is the same. */
  items: ErrorItem[];
  /** Old items that nothing replaced: they become `blocked` with this reason. */
  blocked: { id: string; reason: string }[];
}

/**
 * Replaces the old items of one entry with the rebuilt ones. A rebuilt item
 * inherits the FSRS card of an old item that tested the same word; the old
 * item itself is replaced (deleted by the caller). An old item with no
 * counterpart is blocked, never silently dropped.
 */
export function carryOverSchedule(
  oldItems: readonly ErrorItem[],
  rebuilt: readonly ErrorItem[],
  reasonFor: (old: ErrorItem) => string,
): RebuildOutcome {
  const used = new Set<string>();
  const items = rebuilt.map((next) => {
    const old = oldItems.find((o) => testsSameWord(o, next));
    if (!old) return next;
    used.add(old.id);
    return { ...next, card: old.card, createdAt: old.createdAt };
  });
  const blocked = oldItems
    .filter((o) => !used.has(o.id) && !rebuilt.some((n) => sameSentence(o, n) && testsSameWord(o, n)))
    .map((o) => ({ id: o.id, reason: reasonFor(o) }));
  return { items, blocked };
}
