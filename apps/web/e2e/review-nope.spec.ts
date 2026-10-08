import { expect, test } from './fixtures.js';

// Phase 20: one tap on Nope takes the word out of review; Undo puts it back; Removed words lists it.
test('Nope removes a review card in one tap, Undo brings it back, Removed words can restore it', async ({ page }) => {
  await page.goto('/?page=review');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await page.evaluate(async () => {
    const past = new Date(Date.now() - 86_400_000);
    const card = { due: past, stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 2, last_review: past };
    const row = (id: string) => ({
      pk: `word:${id}:recognition`,
      item: { kind: 'word', id },
      skill: 'recognition',
      card,
      state: 'review',
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      familiarity: 0,
      readingDependence: 0,
      flags: {},
      updatedAt: past,
    });
    const w = window as unknown as { __anan: { db: { items: { bulkPut: (r: unknown[]) => Promise<unknown> } } } };
    await w.__anan.db.items.bulkPut([row('tocfl-53d2a1b065'), row('tocfl-7c491838af')]);
  });
  await page.reload();
  await expect(page.getByTestId('review-counts')).toContainText(/^2 due · /);

  // Before revealing: Nope is there, one tap removes the card.
  await page.getByTestId('nope-btn').click();
  await expect(page.getByTestId('nope-toast')).toBeVisible();
  await expect(page.getByTestId('review-counts')).toContainText(/^1 due · /);

  await page.getByTestId('nope-undo').click();
  await expect(page.getByTestId('nope-toast')).toBeHidden();
  await expect(page.getByTestId('review-counts')).toContainText(/^2 due · /);

  // Nope again, change to "Never show this".
  await page.getByTestId('nope-btn').click();
  await page.getByTestId('nope-change').click();
  await page.getByTestId('nope-choice-never').click();
  await expect(page.getByTestId('nope-toast')).toContainText('Never show this');

  await page.goto('/?page=review-settings');
  const removed = page.getByTestId('removed-words');
  await expect(removed.getByRole('listitem')).toHaveCount(1);
  await expect(removed).toContainText('Never show this');
  await removed.getByRole('button', { name: 'Restore' }).click();
  await expect(removed).toContainText('Nothing removed.');
});
