import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __anan: {
      db: {
        evidence: { toArray: () => Promise<{ kind: string; item: { id: string } }[]> };
        items: { toArray: () => Promise<unknown[]> };
      };
    };
  }
}

test.describe('Reader lookup events feed the learner model', () => {
  test('clicking a token records chat_lookup_gloss evidence and creates/updates its card', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText("An'an reader")).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__anan));
    await expect(page.getByText(/Lexicon v1 · \d+ words/)).toBeVisible({ timeout: 15000 });

    await page.locator('.an-token').first().click();
    await expect(page.locator('.an-popover')).toBeVisible();

    await page.waitForFunction(
      async () => (await window.__anan.db.evidence.toArray()).some((e) => e.kind === 'chat_lookup_gloss'),
      { timeout: 5000 },
    );

    const [evidenceRows, itemRows] = await page.evaluate(async () => [
      await window.__anan.db.evidence.toArray(),
      await window.__anan.db.items.toArray(),
    ]);
    expect(evidenceRows.some((e) => e.kind === 'chat_lookup_gloss')).toBe(true);
    expect(itemRows.length).toBeGreaterThan(0);
  });

  test('hovering a token (without clicking) records chat_hover_reading evidence', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__anan));
    await expect(page.getByText(/Lexicon v1 · \d+ words/)).toBeVisible({ timeout: 15000 });

    await page.locator('.an-token').nth(1).hover();

    await page.waitForFunction(
      async () => (await window.__anan.db.evidence.toArray()).some((e) => e.kind === 'chat_hover_reading'),
      { timeout: 5000 },
    );
    const evidenceRows = await page.evaluate(() => window.__anan.db.evidence.toArray());
    expect(evidenceRows.some((e) => e.kind === 'chat_hover_reading')).toBe(true);
    // A pure hover must never also record a gloss lookup for that interaction.
    expect(evidenceRows.some((e) => e.kind === 'chat_lookup_gloss')).toBe(false);
  });
});
