// Phase 42 (owner, 2026-10-14): the order a word's cards enter Review, for lesson words and
// tutoring words alike:
//   1 Meaning (recognition) → 2 Pick the Mandarin → 3 Say it (the pinyin) → 4 Recall (type it).
// Phase 43 Part B: a face's New card waits until the face before it is consistently known (Good or
// Easy twice in a row, in different sessions: `good-run.ts`), and enters from the session after
// that, never the same one. Pure; the session start is passed in.

import type { SkillCard } from '../learner/types.js';
import { isLearnedCard, isNewCard } from './terms.js';
import { faceReleasedBefore } from './good-run.js';

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

/** The learner has said they know this card: rated Good or Easy once (`flags.knownFace`; "Not yet"
 * on the Rate your words screen sets it false), or, for a card from before Phase 42 with no rating,
 * Learned. */
export const knownFace = (c: SkillCard): boolean =>
  c.state !== 'unseen' && !isNewCard(c) && (c.flags.knownFace ?? isLearnedCard(c));

/** `skill|wordId` of every word card the learner knows (`knownFace`). */
export function knownFaceKeys(cards: readonly SkillCard[]): Set<string> {
  const out = new Set<string>();
  for (const c of cards) if (c.item.kind === 'word' && knownFace(c)) out.add(`${c.skill}|${c.item.id}`);
  return out;
}

/** `skill|wordId` of every word card consistently known before `sessionStart` (Phase 43). */
export function releasedFaceKeys(cards: readonly SkillCard[], sessionStart: Date): Set<string> {
  const out = new Set<string>();
  for (const c of cards)
    if (c.item.kind === 'word' && c.state !== 'unseen' && !isNewCard(c) && faceReleasedBefore(c, sessionStart))
      out.add(`${c.skill}|${c.item.id}`);
  return out;
}

/** May this card enter Review in this session? Cards already answered always may; a New Pick card
 * waits for Meaning to be released (`releasedFaceKeys`), a New Say it card for Pick. */
export function faceGateOpen(c: SkillCard, released: ReadonlySet<string>): boolean {
  if (c.item.kind !== 'word' || !isNewCard(c)) return true;
  const before = PREVIOUS_FACE[c.skill];
  return before === undefined || released.has(`${before}|${c.item.id}`);
}
