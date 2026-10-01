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
