import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };
  }
}

test('rating a card persists immediately and survives a full page reload', async ({ page }) => {
  await page.goto('/?page=review');
  await page.waitForFunction(() => Boolean(window.__anan));

  await page.evaluate(async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 86_400_000);
    const mk = (id: string) => ({
      pk: `word:${id}:recognition`,
      item: { kind: 'word', id },
      skill: 'recognition',
      card: {
        due: past,
        stability: 5,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        last_review: past,
      },
      state: 'review',
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      familiarity: 0,
      readingDependence: 0,
      flags: {},
      updatedAt: now,
    });
    await window.__anan.db.items.bulkPut([mk('tocfl-53d2a1b065'), mk('tocfl-7c491838af')]);
  });

  await page.reload();
  await expect(page.getByText(/2 due now/)).toBeVisible();

  await page.getByRole('button', { name: 'Show answer' }).click();
  await page.getByRole('button', { name: 'Good' }).click();
  await page.waitForTimeout(150);

  // Still mid-session: the in-memory queue has advanced to the 2nd card,
  // but the session total hasn't changed (that's the "of N this session" figure).
  await expect(page.getByText(/1 due now \(of 2 this session\)/)).toBeVisible();

  // Reload WITHOUT rating the 2nd card — if the rating from before the
  // reload hadn't actually been persisted, this fresh due-queue fetch would
  // still show 2 due now instead of 1.
  await page.reload();
  await expect(page.getByText(/1 due now \(of 1 this session\)/)).toBeVisible();
});
