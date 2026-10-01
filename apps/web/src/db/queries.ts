import type { SkillCard } from '@anan/core';
import type { AnanDB } from './schema.js';

/** Count of cards due on each of the next `days` calendar days (today
 * first), for the review screen's forecast. Direct Dexie query — not part
 * of the core LearnerRepo contract, which only needs dueCards()/knownSet(). */
export async function dueForecast(db: AnanDB, now: Date, days = 7): Promise<number[]> {
  const dayStart = (offset: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
  };

  const counts: number[] = [];
  for (let i = 0; i < days; i++) {
    const from = dayStart(i);
    const to = dayStart(i + 1);
    const count = await db.items.where('card.due').between(from, to, true, false).count();
    counts.push(count);
  }
  return counts;
}

/** All cards ever touched (any state past 'unseen'), for consumers that need
 * the learner's whole history rather than just what's currently due —
 * `currentFrontierLevel()` and pinyin fading's per-word `readingDisplay()`
 * both need this, and neither fits the `LearnerRepo.dueCards()`/`knownSet()`
 * contract (which is deliberately narrow — see Phase 2). Not part of
 * LearnerRepo for the same reason dueForecast isn't: a direct Dexie
 * convenience, not a cross-storage-backend API. */
export async function allTouchedCards(db: AnanDB): Promise<SkillCard[]> {
  const rows = await db.items.where('state').notEqual('unseen').toArray();
  return rows.map(({ pk: _pk, ...card }) => card);
}

export async function recognitionCardsByWordId(db: AnanDB): Promise<Map<string, SkillCard>> {
  const cards = await allTouchedCards(db);
  const map = new Map<string, SkillCard>();
  for (const card of cards) {
    if (card.skill === 'recognition') map.set(card.item.id, card);
  }
  return map;
}
