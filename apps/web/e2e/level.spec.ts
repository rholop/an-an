import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: { settings: { get: (k: string) => Promise<{ value: unknown } | undefined> } };
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
    };
  }
}

const picker = (page: import('@playwright/test').Page) => page.getByLabel('My level');

test.describe('Level picker everywhere + accurate definitions (phase 7)', () => {
  test('the header picker lists exactly the 7 TOCFL levels, labelled with name and CEFR band', async ({
    page,
  }) => {
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    const options = await picker(page).locator('option').allTextContents();
    expect(options).toEqual([
      'N1 準備級一級 · pre-A1',
      'N2 準備級二級 · pre-A1',
      'L1 入門級 · A1',
      'L2 基礎級 · A2',
      'L3 進階級 · B1',
      'L4 高階級 · B2',
      'L5 流利級 · C1–C2',
    ]);
  });

  test('changing the level updates chat, reader and garden without a reload, and persists', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.__anan));
    await picker(page).selectOption('N1');

    // Reader: words above N1 are highlighted; at L5 nothing is above the level.
    await page.waitForSelector('.an-token');
    const aboveAtN1 = await page.locator('.an-token--above').count();
    expect(aboveAtN1).toBeGreaterThan(0);
    await picker(page).selectOption('L5');
    await expect(page.locator('.an-token--above')).toHaveCount(0);
    await picker(page).selectOption('N1');
    await expect(page.locator('.an-token--above')).toHaveCount(aboveAtN1);

    // Chat: the scenario list follows the chosen level (per-screen chips default to it).
    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByText('Your level: N1')).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator('.chat-scenario-card', { hasText: 'Ordering a drink at a tea shop' }),
    ).toBeVisible();
    await expect(
      page.locator('.chat-scenario-card', { hasText: 'Asking a landlord about the deposit' }),
    ).toHaveCount(0);
    await picker(page).selectOption('L4');
    await expect(page.getByText('Your level: L4')).toBeVisible();
    await expect(
      page.locator('.chat-scenario-card', { hasText: 'Asking a landlord about the deposit' }),
    ).toBeVisible();
    await expect(
      page.locator('.chat-scenario-card', { hasText: 'Ordering a drink at a tea shop' }),
    ).toHaveCount(0);
    // a per-screen chip changes the list but NOT the global level
    await page
      .getByRole('group', { name: 'Filter by level' })
      .getByRole('button', { name: 'All' })
      .click();
    await expect(
      page.locator('.chat-scenario-card', { hasText: 'Ordering a drink at a tea shop' }),
    ).toBeVisible();
    await expect(picker(page)).toHaveValue('L4');

    // Garden: its level chips default to the current level.
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('button', { name: /^L4/, pressed: true })).toBeVisible({
      timeout: 15000,
    });

    // Persisted in Dexie, and still there after a reload.
    expect((await page.evaluate(() => window.__anan.db.settings.get('currentLevel')))?.value).toBe(
      'L4',
    );
    await page.reload();
    await expect(picker(page)).toHaveValue('L4');

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('the popover picks the sense from context and shows its source', async ({ page }) => {
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    const input = page.locator('.reader-input');

    await input.fill('我騎機車去上班。');
    await page.locator('.an-token', { hasText: '機車' }).first().click();
    await expect(page.locator('.an-popover-gloss')).toContainText(/scooter|motorcycle/);
    await expect(page.locator('.an-popover-source').first()).toContainText(
      /CC-CEDICT|An'an|Wiktionary/,
    );
    await page.locator('.an-popover-close').click();

    await input.fill('他很機車。');
    await page.locator('.an-token', { hasText: '機車' }).first().click();
    await expect(page.locator('.an-popover-gloss')).toContainText('annoying');
    // other meanings are collapsed under a <details>
    await expect(page.locator('.an-popover-others summary')).toContainText(/other meaning/);
  });

  test('report this definition + the credits page lists every bundled dictionary', async ({
    page,
  }) => {
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    await page.locator('.reader-input').fill('他很機車。');
    await page.locator('.an-token', { hasText: '機車' }).first().click();
    await page.getByTestId('report-definition').click();

    await page.getByTestId('nav-more').click(); // Phase 22: Credits lives in the More menu
    await page.getByRole('menuitem', { name: 'Credits' }).click();
    const list = page.getByTestId('credits-list');
    for (const name of [
      'CC-CEDICT',
      'Wiktionary',
      'MOE Revised Mandarin Chinese Dictionary',
      'Unihan',
    ]) {
      await expect(list).toContainText(name);
    }
    await expect(list).toContainText('CC BY-SA 4.0');
    await expect(list).toContainText('CC BY-ND 3.0 TW');
    await expect(page.getByLabel('Exported reports')).toHaveValue(/word: "機車"/);
  });

  test('unlisted words can be defined on demand, labelled AI-generated', async ({ page }) => {
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    await page.locator('.reader-input').fill('我喝龘龘茶。');
    const panel = page.getByTestId('unlisted-words');
    await expect(panel).toBeVisible();
    await panel.getByLabel(/Use fake tutor/).check();
    await panel.getByRole('button', { name: 'Define (AI)' }).first().click();
    await expect(panel).toContainText('AI-generated');
  });
});
