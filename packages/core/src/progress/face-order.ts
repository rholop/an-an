// Phase 42: the order a word's cards enter Review, for lesson words and tutoring words alike:
//   1 Meaning (recognition) → 2 Pick the Mandarin → 3 Say it (the pinyin) → 4 Recall (type it).
// A face's New card waits until the face before it has been answered once. Pure; no clock.

import type { SkillCard } from '../learner/types.js';
import { isNewCard } from './terms.js';

/** Where a card sits in the face order (lower enters first). Recall is a rung of the production
 * card, so a production card at the Recall rung is last. */
export function faceStage(c: Pick<SkillCard, 'skill' | 'item' | 'prodRung'>): 0 | 1 | 2 | 3 {
  if (c.item.kind !== 'word') return 0;
  if (c.skill === 'production') return c.prodRung === 'recall' ? 3 : 1;
  if (c.skill === 'reading') return 2;
  return 0;
}

/** The face a word must have answered before `skill`'s New card may enter Review. */
const PREVIOUS_FACE: Partial<Record<SkillCard['skill'], SkillCard['skill']>> = {
  production: 'recognition',
  reading: 'production',
};

/** `skill|wordId` of every word card that has been answered at least once (not New, not unseen). */
export function answeredFaceKeys(cards: readonly SkillCard[]): Set<string> {
  const out = new Set<string>();
  for (const c of cards)
    if (c.item.kind === 'word' && c.state !== 'unseen' && !isNewCard(c)) out.add(`${c.skill}|${c.item.id}`);
  return out;
}

/** May this card enter Review now? Cards already answered always may; a New Pick card waits for
 * Meaning, a New Say it card waits for Pick. */
export function faceGateOpen(c: SkillCard, answered: ReadonlySet<string>): boolean {
  if (c.item.kind !== 'word' || !isNewCard(c)) return true;
  const before = PREVIOUS_FACE[c.skill];
  return before === undefined || answered.has(`${before}|${c.item.id}`);
}
