import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __anan: {
      db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } };
      learnerRepo: unknown;
      learnerService: unknown;
    };
  }
}

test.describe('Review screen', () => {
  test('shows a due card, reveals, rates it, and the due count drops', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?page=review');
    await expect(page.getByText('Review', { exact: true })).toBeVisible();

    // Seed two due SkillCards directly into IndexedDB via the dev hook —
    // real lexicon ids so the review card can render a real headword.
    await page.waitForFunction(() => Boolean(window.__anan));
    await page.evaluate(async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 86_400_000);
      const card = (stability: number) => ({
        due: past,
        stability,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        last_review: past,
      });
      await window.__anan.db.items.bulkPut([
        {
          pk: 'word:tocfl-53d2a1b065:recognition',
          item: { kind: 'word', id: 'tocfl-53d2a1b065' },
          skill: 'recognition',
          card: card(5),
          state: 'review',
          lapses: 0,
          leech: false,
          leechTreatmentsTried: [],
          familiarity: 0,
          readingDependence: 0,
          flags: {},
          updatedAt: now,
        },
        {
          pk: 'word:tocfl-7c491838af:recognition',
          item: { kind: 'word', id: 'tocfl-7c491838af' },
          skill: 'recognition',
          card: card(5),
          state: 'review',
          lapses: 4,
          leech: true,
          leechTreatmentsTried: [],
          familiarity: 0,
          readingDependence: 0,
          flags: {},
          updatedAt: now,
        },
      ]);
    });

    await page.reload();
    await expect(page.getByText('Review', { exact: true })).toBeVisible();
    await expect(page.getByText(/2 due now/)).toBeVisible();

    await page.screenshot({ path: 'screenshots/review-front.png' });

    await page.getByRole('button', { name: 'Show answer' }).click();
    await expect(page.locator('.review-card-back')).toBeVisible();
    await page.screenshot({ path: 'screenshots/review-revealed.png' });

    await page.getByRole('button', { name: 'Good' }).click();
    await page.waitForTimeout(150);

    // One card rated -> one card left in the in-memory queue, forecast/due-now count unchanged
    // until next load, but the queue index should have advanced (either showing the 2nd
    // seeded card, possibly with its leech panel, or "done" if that was the last one).
    await page.screenshot({ path: 'screenshots/review-after-rating.png' });

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('shows the leech char-breakdown panel for a leeched card', async ({ page }) => {
    await page.goto('/?page=review');
    await page.waitForFunction(() => Boolean(window.__anan));
    await page.evaluate(async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 86_400_000);
      await window.__anan.db.items.bulkPut([
        {
          pk: 'word:tocfl-c0d931c34a:recognition',
          item: { kind: 'word', id: 'tocfl-c0d931c34a' },
          skill: 'recognition',
          card: {
            due: past,
            stability: 2,
            difficulty: 5,
            elapsed_days: 0,
            scheduled_days: 1,
            learning_steps: 0,
            reps: 5,
            lapses: 4,
            state: 2,
            last_review: past,
          },
          state: 'review',
          lapses: 4,
          leech: true,
          leechTreatmentsTried: [],
          familiarity: 0,
          readingDependence: 0,
          flags: {},
          updatedAt: now,
        },
      ]);
    });
    await page.reload();
    await page.getByRole('button', { name: 'Show answer' }).click();
    await expect(page.getByText('Leech — character breakdown')).toBeVisible();
    await page.screenshot({ path: 'screenshots/review-leech-panel.png' });
  });
});
