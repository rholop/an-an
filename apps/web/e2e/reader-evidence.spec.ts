import { expect, test } from './fixtures.js';

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
  test('clicking a token records chat_lookup_gloss evidence and creates/updates its card', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByText("An'an reader")).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__anan));
    await expect(page.getByText(/Lexicon v2 · \d+ words/)).toBeVisible({ timeout: 15000 });

    await page.locator('.an-token').first().click();
    await expect(page.locator('.an-popover')).toBeVisible();

    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).some(
          (e) => e.kind === 'chat_lookup_gloss',
        ),
      )
      .toBe(true);

    const [evidenceRows, itemRows] = await page.evaluate(async () => [
      await window.__anan.db.evidence.toArray(),
      await window.__anan.db.items.toArray(),
    ]);
    expect(evidenceRows.some((e) => e.kind === 'chat_lookup_gloss')).toBe(true);
    expect(itemRows.length).toBeGreaterThan(0);
  });

  test('hovering a token while the reading is visible records nothing', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__anan));
    await expect(page.getByText(/Lexicon v2 · \d+ words/)).toBeVisible({ timeout: 15000 });

    // Default mode is 'always' (reading on screen): hover is just the pointer passing over.
    for (const script of ['pinyin', 'zhuyin', 'both']) {
      await page.locator('.reader-controls select').nth(1).selectOption(script);
      await page.locator('.an-token').nth(1).hover();
      await page.locator('.an-token').nth(2).hover();
    }
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() => window.__anan.db.evidence.toArray());
    expect(rows.some((e) => e.kind === 'chat_hover_reading')).toBe(false);
  });

  test('hovering a token whose reading is hidden records chat_hover_reading evidence', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__anan));
    await expect(page.getByText(/Lexicon v2 · \d+ words/)).toBeVisible({ timeout: 15000 });

    await page.locator('.reader-controls select').nth(0).selectOption('hover');
    await page.locator('.an-token').nth(1).hover();

    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).some(
          (e) => e.kind === 'chat_hover_reading',
        ),
      )
      .toBe(true);
    const evidenceRows = await page.evaluate(() => window.__anan.db.evidence.toArray());
    expect(evidenceRows.some((e) => e.kind === 'chat_hover_reading')).toBe(true);
    // A pure hover must never also record a gloss lookup for that interaction.
    expect(evidenceRows.some((e) => e.kind === 'chat_lookup_gloss')).toBe(false);
  });
});
