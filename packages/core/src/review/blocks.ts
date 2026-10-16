// Phase 43 Part D/E (owner, 2026-10-16: "The types of cards are mixed"): a review session runs in
// blocks by card type, in the face order (Meaning, then Pick, then Say it, then Recall), with grammar
// cards last. Inside a block the shared order still keeps siblings apart. An Again card goes back to
// the end of its own block. Pure; the seed is passed in.

import type { SkillCard } from '../learner/types.js';
import {
  markOrderedSession,
  orderSession,
  sessionMeta,
  type OrderedSession,
  type OrderSessionOptions,
  type SessionCard,
} from '../session/orderSession.js';
import { reviewFace } from './faces.js';

export type ReviewBlock = 'meaning' | 'pick' | 'say' | 'recall' | 'grammar';
export const REVIEW_BLOCKS: readonly ReviewBlock[] = ['meaning', 'pick', 'say', 'recall', 'grammar'];

/** The block a card belongs to (its face). */
export const reviewBlock = (c: Pick<SkillCard, 'item' | 'skill' | 'prodRung' | 'state' | 'card'>): ReviewBlock => reviewFace(c);

/**
 * Order a session in blocks: each block ordered by `orderSession` (bands, seeded shuffle, siblings
 * apart, carrying the previous block's last cards as `recent`); a sibling the gap would hold back goes
 * at the end of its own block, so every card given is in the session.
 */
export function orderInBlocks<T>(
  cards: readonly T[],
  blockOf: (card: T) => ReviewBlock,
  describe: (card: T) => SessionCard,
  opts: OrderSessionOptions,
): OrderedSession<T> {
  const out: T[] = [];
  const recent: (readonly string[])[] = [...(opts.recent ?? [])];
  for (const b of REVIEW_BLOCKS) {
    const mine = cards.filter((c) => blockOf(c) === b);
    if (mine.length === 0) continue;
    const ordered = orderSession(mine, describe, { ...opts, seed: `${opts.seed}:${b}`, recent });
    const all = [...ordered, ...(sessionMeta(ordered)?.deferred ?? [])];
    out.push(...all);
    for (const c of all) recent.push(describe(c).keys);
  }
  return markOrderedSession(out, { seed: opts.seed, deferred: [] });
}

/** Phase 43 Part E.1: the queue with the card at `at` put back as the last card of its block (the
 * rest of the block comes first; a block of one shows it again at once). `replace`: the card as it is
 * now. */
export function requeueInBlock<T>(queue: readonly T[], at: number, blockOf: (card: T) => ReviewBlock, replace?: T): T[] {
  const card = queue[at];
  if (card === undefined) return [...queue];
  const block = blockOf(card);
  let end = at + 1;
  for (let j = at + 1; j < queue.length; j++) if (blockOf(queue[j]!) === block) end = j + 1;
  return [...queue.slice(0, end), replace ?? card, ...queue.slice(end)];
}

/** The block of the card at `index` and how many cards of it are left from there ("Meaning · 12"). */
export function blockAt<T>(queue: readonly T[], index: number, blockOf: (card: T) => ReviewBlock): { block: ReviewBlock; left: number } | undefined {
  const card = queue[index];
  if (card === undefined) return undefined;
  const block = blockOf(card);
  return { block, left: queue.slice(index).filter((c) => blockOf(c) === block).length };
}
