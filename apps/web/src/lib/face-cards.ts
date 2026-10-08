import { productionUnlockFor, readingUnlockFor, type Evidence, type SkillCard } from '@anan/core';
import { learnerService } from '../db/instance.js';

/**
 * Phase 23 Part B one-time catch-up (safe to run any time; it only adds what is missing): every
 * word whose recognition card is Learned gets its production card (so Pick / Recall faces exist),
 * and every word whose recognition card has reached learning gets its reading card (Say it, Pinyin
 * & tones). New answers unlock them as they happen (learner-service); this covers older progress.
 * Returns how many cards were created.
 */
export async function ensureFaceCards(
  now: Date = new Date(),
  deps: { allCards: () => Promise<SkillCard[]>; recordBulk: (e: Evidence[], now: Date) => Promise<unknown> } = {
    allCards: () => learnerService.allCards(),
    recordBulk: (e, n) => learnerService.recordBulk(e, n),
  },
): Promise<number> {
  const cards = await deps.allCards();
  const has = new Set(cards.filter((c) => c.state !== 'unseen').map((c) => `${c.item.kind}:${c.item.id}|${c.skill}`));
  const events: Evidence[] = [];
  for (const c of cards) {
    if (c.skill !== 'recognition' || c.item.kind !== 'word') continue;
    const key = `${c.item.kind}:${c.item.id}`;
    const p = productionUnlockFor(c, has.has(`${key}|production`), now);
    if (p) events.push(p);
    const r = readingUnlockFor(c, has.has(`${key}|reading`), now);
    if (r) events.push(r);
  }
  if (events.length > 0) await deps.recordBulk(events, now);
  return events.length;
}
