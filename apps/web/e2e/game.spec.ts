import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __anan: {
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
      gameService: { allRewards: () => Promise<{ kind: string; points: number }[]> };
    };
  }
}

/** Seeds three N1 words as reviewed a year ago, so their retrievability has collapsed. */
async function seedStaleWords(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__anan));
  await page.evaluate(async () => {
    const data = (await (await fetch('/lexicon/lexicon.v1.json')).json()) as {
      words: { id: string; level: string | null }[];
    };
    const long = new Date(Date.now() - 365 * 86_400_000);
    for (const w of data.words.filter((x) => x.level === 'N1').slice(0, 3)) {
      for (let i = 0; i < 2; i++) {
        await window.__anan.learnerService.record(
          { item: { kind: 'word', id: w.id }, skill: 'recognition', kind: 'review_good', at: long },
          new Date(long.getTime() + i * 86_400_000),
        );
      }
    }
  });
}

test.describe('Game layer', () => {
  test('the garden wilts stale words and a plot can be watered with a focused review', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await seedStaleWords(page);
    await page.goto('/?page=garden');
    await expect(page.getByRole('heading', { name: 'Word garden' })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator('.garden-tile--withered, .garden-tile--wilting').first(),
    ).toBeVisible();
    await expect(page.locator('.garden-tile[aria-label*="needs water"]').first()).toBeVisible();

    await page
      .getByRole('button', { name: /Water \d+ wilting/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Water these words' })).toBeVisible();
    await page.getByRole('button', { name: 'Show answer' }).click();
    await page.getByRole('button', { name: 'Good' }).click();
    await page.getByRole('button', { name: '← Back to garden' }).click();
    await expect(page.getByRole('heading', { name: 'Word garden' })).toBeVisible();

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('progress shows learning-only points, real-world coverage and hides streaks by default', async ({
    page,
  }) => {
    await seedStaleWords(page);
    await page.goto('/?page=progress');
    await expect(page.getByRole('heading', { name: /Points: \d+/ })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/never from\s+time spent/)).toBeVisible();
    await expect(page.getByText(/Recalled a word/)).toBeVisible();
    await expect(page.getByTestId('streak')).toHaveCount(0);
    await expect(page.getByText(/you can handle ~\d+% of the words/).first()).toBeVisible();
    await expect(page.getByTestId('retention')).toContainText('Review retention');

    await page.getByText('Streak settings').click();
    await page.getByLabel(/Show a gentle streak/).check();
    await expect(page.getByTestId('streak')).toContainText('Current run');
  });

  test('the scenario map shows stars, locks and coverage', async ({ page }) => {
    await page.goto('/?page=chat');
    await expect(page.getByText(/Your level:/)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.chat-scenario-card')).toHaveCount(7);
    await expect(page.locator('.chat-scenario-card:disabled').first()).toContainText('locked');
    await expect(
      page.locator('.chat-scenario-card', { hasText: 'Ordering a drink at a tea shop' }),
    ).toContainText('You know ~');
    await expect(page.locator('.chat-stars').first()).toHaveAttribute('aria-label', /of 3 stars/);
  });
});
