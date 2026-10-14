// Phase 42 (owner, 2026-10-14): the order a word's cards enter Review, for lesson words and
// tutoring words alike:
//   1 Meaning (recognition) → 2 Pick the Mandarin → 3 Say it (the pinyin) → 4 Recall (type it).
// A face's New card waits until the face before it has been rated Good or Easy once ("I know
// this"); Again and Hard don't release it. Pure; no clock.

import type { SkillCard } from '../learner/types.js';
import { isLearnedCard, isNewCard } from './terms.js';

/** Where a card sits in the face order (lower enters first). Recall is a rung of the production
 * card, so a production card at the Recall rung is last. */
export function faceStage(c: Pick<SkillCard, 'skill' | 'item' | 'prodRung'>): 0 | 1 | 2 | 3 {
  if (c.item.kind !== 'word') return 0;
  if (c.skill === 'production') return c.prodRung === 'recall' ? 3 : 1;
  if (c.skill === 'reading') return 2;
  return 0;
}

/** The face a word must know before `skill`'s New card may enter Review. */
const PREVIOUS_FACE: Partial<Record<SkillCard['skill'], SkillCard['skill']>> = {
  production: 'recognition',
  reading: 'production',
};

/** The learner has said they know this card: rated Good or Easy once (`flags.knownFace`), or, for a
 * card from before Phase 42, Learned. */
export const knownFace = (c: SkillCard): boolean =>
  c.state !== 'unseen' && !isNewCard(c) && (!!c.flags.knownFace || isLearnedCard(c));

/** `skill|wordId` of every word card the learner knows (`knownFace`). */
export function knownFaceKeys(cards: readonly SkillCard[]): Set<string> {
  const out = new Set<string>();
  for (const c of cards) if (c.item.kind === 'word' && knownFace(c)) out.add(`${c.skill}|${c.item.id}`);
  return out;
}

/** May this card enter Review now? Cards already answered always may; a New Pick card waits for
 * Meaning to be rated Good/Easy, a New Say it card for Pick. */
export function faceGateOpen(c: SkillCard, known: ReadonlySet<string>): boolean {
  if (c.item.kind !== 'word' || !isNewCard(c)) return true;
  const before = PREVIOUS_FACE[c.skill];
  return before === undefined || known.has(`${before}|${c.item.id}`);
}
