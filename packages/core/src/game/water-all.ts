// Phase 22 Part B: "💧 Water all" — one mixed session over every word in the garden that needs
// water (a card in this review session, Phase 23), across all plots and levels. Each Due card becomes a flashcard or a cloze,
// in the shared session order (Phase 19); listening extras are placed by the caller. Every card
// it was given is in the session (siblings the gap would defer go at the end), so the count on
// the button is exactly what opens. Pure; the seed makes it repeatable.

import { hashText } from '../hash.js';
import type { SkillCard } from '../learner/types.js';
import { isReviewSkill } from '../progress/terms.js';
import { describeSkillCard, keepDeferred, orderSession } from '../session/orderSession.js';

export type WaterEntry<S> =
  { kind: 'flash'; card: SkillCard } | { kind: 'cloze'; card: SkillCard; item: S };

/** The cards Water all covers: this session's word cards (`sessionCards`; one plant may have
 * several). */
export function waterAllCards(
  sessionCards: readonly SkillCard[],
  inGarden: (wordId: string) => boolean = () => true,
): SkillCard[] {
  return sessionCards.filter((c) => c.item.kind === 'word' && isReviewSkill(c.skill) && inGarden(c.item.id));
}

/** Distinct words in `cards` (what "Water all (N)" counts). */
export const wateredWordCount = (cards: readonly SkillCard[]): number =>
  new Set(cards.map((c) => c.item.id)).size;

/**
 * Flashcard or cloze per card: about half are clozes, chosen by a hash of the card and the
 * session seed, and only where a cloze can be built (`clozeFor` returns its item).
 */
export function planWaterAll<S>(
  cards: readonly SkillCard[],
  opts: {
    seed: string;
    clozeFor: (card: SkillCard) => S | null;
    recent?: readonly (readonly string[])[];
  },
): WaterEntry<S>[] {
  const entries = cards.map((card): WaterEntry<S> => {
    const pick =
      parseInt(hashText(`${opts.seed}|${card.item.kind}:${card.item.id}|${card.skill}`), 36) % 2 ===
      0;
    const item = pick ? opts.clozeFor(card) : null;
    return item ? { kind: 'cloze', card, item } : { kind: 'flash', card };
  });
  const ordered = orderSession(entries, (e) => describeSkillCard(e.card), {
    seed: opts.seed,
    ...(opts.recent ? { recent: opts.recent } : {}),
  });
  return keepDeferred(ordered);
}
