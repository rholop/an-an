import { expect, test } from '@playwright/test';

test.describe('Reader page', () => {
  test('loads the lexicon and renders all four modes / three scripts', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/');
    await expect(page.getByText("An'an reader")).toBeVisible();
    await expect(page.getByText(/Lexicon v2 · \d+ words/)).toBeVisible({ timeout: 15000 });

    await page.screenshot({ path: 'screenshots/reader-always-pinyin.png' });

    await page.locator('.reader-controls select').nth(1).selectOption('zhuyin');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/reader-always-zhuyin.png' });

    await page.locator('.reader-controls select').nth(1).selectOption('both');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/reader-always-both.png' });

    await page.locator('.reader-controls select').nth(0).selectOption('hover');
    await page.waitForTimeout(150);
    // Not hovering/open: the reading must actually be hidden, not just
    // present-but-styled — a screenshot alone wouldn't catch a race where
    // the annotation briefly renders before the mode class applies.
    await expect(page.locator('.an-token rt').first()).toHaveCSS('opacity', '0');
    await page.screenshot({ path: 'screenshots/reader-hover-mode.png' });

    await page.locator('.an-token').first().hover();
    await page.waitForTimeout(150);
    await expect(page.locator('.an-token rt').first()).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'screenshots/reader-hover-mode-hovering.png' });

    await page.locator('.reader-controls select').nth(0).selectOption('tone-only');
    await page.locator('.reader-controls select').nth(1).selectOption('pinyin');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/reader-tone-only.png' });

    await page.locator('.reader-controls select').nth(0).selectOption('off');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'screenshots/reader-mode-off.png' });

    await page.locator('.reader-controls select').nth(0).selectOption('always');
    await page.waitForTimeout(150);
    await page.locator('.an-token').first().click();
    await expect(page.locator('.an-popover')).toBeVisible();
    await page.screenshot({ path: 'screenshots/reader-popover.png' });

    await page.fill('textarea', '我在北京坐地铁去朋友家。');
    await expect(page.getByText('Taiwan-ness warnings')).toBeVisible();
    await page.screenshot({ path: 'screenshots/reader-taiwanness.png' });

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('zhuyin rendering comparison page', async ({ page }) => {
    await page.goto('/?page=zhuyin-test');
    await expect(page.getByText('Zhuyin rendering comparison')).toBeVisible();
    await page.screenshot({ path: 'screenshots/zhuyin-test-page.png', fullPage: true });
  });
});
