import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Phase 47: `n` N1 words with an answered Meaning card due in five days (in no review session), so
 * Cloze practises them. `include` are lexicon ids that must be among them. Returns the ids. */
export async function seedAnsweredWords(page: Page, n: number, include: string[] = []): Promise<string[]> {
  return page.evaluate(
    async ({ n, include }) => {
      const data = (await (await fetch('/lexicon/lexicon.v2.json')).json()) as {
        words: { id: string; level: string | null; tags: string[] }[];
      };
      const ids = [
        ...include,
        ...data.words.filter((w) => w.level === 'N1' && !w.tags.includes('name') && !include.includes(w.id)).map((w) => w.id),
      ].slice(0, n);
      const now = Date.now();
      const rows = ids.map((id, i) => ({
        pk: `word:${id}:recognition`,
        item: { kind: 'word', id },
        skill: 'recognition',
        state: 'review',
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
        clozeRung: 1,
        clozeStreak: 0,
        familiarity: 0,
        readingDependence: 0,
        // Meaning not consistently known yet, so no Pick card joins the session (face order)
        flags: { goodRun: 1 },
        updatedAt: new Date(now),
        card: {
          due: new Date(now + 5 * 86_400_000),
          stability: 6 + (i % 5),
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 7,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          state: 2,
          last_review: new Date(now - 2 * 86_400_000),
        },
      }));
      const db = (window as unknown as { __anan: { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } } }).__anan.db;
      await db.items.bulkPut(rows);
      return ids;
    },
    { n, include },
  );
}

/** Phase 47: answer word clozes (any answer) until a journal fix is on screen. */
export async function answerUntilJournalFix(page: Page): Promise<void> {
  for (let step = 0; step < 25; step++) {
    if (await page.locator('.cloze-badge', { hasText: 'From your journal' }).isVisible()) return;
    const chip = page.locator('.cloze-exercise .cloze-chip').first();
    await expect(page.locator('.cloze-sentence, .cloze-prompt').first()).toBeVisible();
    if (await chip.isVisible()) await chip.click();
    else {
      await page.locator('.cloze-exercise input').first().fill('字');
      await page.keyboard.press('Enter');
    }
    await page.getByRole('button', { name: /^Next/ }).first().click();
  }
  throw new Error('no journal fix in the session');
}
