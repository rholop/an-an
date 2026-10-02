import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: {
        evidence: { toArray: () => Promise<{ kind: string; item: { id: string } }[]> };
      };
    };
  }
}

test.describe('Cloze page', () => {
  test('a freshly-introduced due item can be reviewed with evidence recorded', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    // Seed a few due items the same way reader-evidence.spec.ts proves tap
    // evidence works: clicking a token introduces its word (due = now).
    await page.goto('/');
    await expect(page.getByText(/Lexicon v2 · \d+ words/)).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.__anan));
    for (let i = 0; i < 3; i++) {
      await page.locator('.an-token').nth(i).click();
      await page.locator('.an-popover-close').click();
    }
    await page.waitForFunction(
      async () =>
        (await window.__anan.db.evidence.toArray()).filter((e) => e.kind === 'chat_lookup_gloss')
          .length >= 3,
      { timeout: 5000 },
    );

    await page.goto('/?page=cloze');
    const startButton = page.getByRole('button', { name: /Start session/ });
    await expect(startButton).toBeVisible({ timeout: 15000 });
    await startButton.click();

    // A brand-new card starts at clozeRung 1 -> word_bank: a gloss prompt
    // (no sentence bank/chat history seeded in this test) with chips.
    await expect(page.getByText(/Which word means:/)).toBeVisible();
    await expect(page.locator('.cloze-chip').first()).toBeVisible();

    await page.locator('.cloze-chip').first().click();
    await expect(page.locator('.cloze-feedback')).toBeVisible();
    await page.screenshot({ path: 'screenshots/cloze-answered.png' });

    await page.waitForFunction(
      async () =>
        (await window.__anan.db.evidence.toArray()).some(
          (e) => e.kind === 'cloze_correct_nohint' || e.kind === 'cloze_wrong',
        ),
      { timeout: 5000 },
    );

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/Item 2 \//)).toBeVisible();

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });
});
