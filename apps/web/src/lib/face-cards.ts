import { productionUnlockFor, readingUnlockFor, type Evidence, type Ledger } from '@anan/core';
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
  deps: { ledger: (now: Date) => Promise<Ledger>; recordBulk: (e: Evidence[], now: Date) => Promise<unknown> } = {
    ledger: (n) => learnerService.ledger(n),
    recordBulk: (e, n) => learnerService.recordBulk(e, n),
  },
): Promise<number> {
  const ledger = await deps.ledger(now);
  const events: Evidence[] = [];
  for (const c of ledger.cards) {
    if (c.skill !== 'recognition' || c.item.kind !== 'word') continue;
    const p = productionUnlockFor(c, ledger.hasMetCard(c.item, 'production'), now);
    if (p) events.push(p);
    const r = readingUnlockFor(c, ledger.hasMetCard(c.item, 'reading'), now);
    if (r) events.push(r);
  }
  if (events.length > 0) await deps.recordBulk(events, now);
  return events.length;
}
