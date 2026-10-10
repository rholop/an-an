import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { eveningZone, expect, test } from './fixtures.js';

/**
 * Phase 32: the Home streak bar is one slim row (≤ 28 px) at phone and desktop widths, shows the
 * active days, and opens Progress at the streak. With THEME_SCREENS=1 it also saves the bar in both
 * themes to docs/theme-screens/.
 */

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/theme-screens');
const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
] as const;
const THEMES = ['light', 'dark'] as const;

type Handle = { db: { activeDays: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

/** Active the last 12 days before today (in the fixture's profile zone); today still open. */
async function seedActiveDays(page: Page) {
  await page.goto('/?page=garden');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await page.evaluate(async (timeZone) => {
    const day = 86_400_000;
    const key = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone });
    const rows = Array.from({ length: 12 }, (_, i) => {
      const at = Date.now() - (i + 1) * day;
      return { day: key(at), at: new Date(at) };
    });
    await (window as unknown as { __anan: Handle }).__anan.db.activeDays.bulkPut(rows);
  }, eveningZone());
}

for (const size of SIZES) {
  test(`streak bar: one slim row at ${size.name} width, opens Progress`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedActiveDays(page);
    await page.goto('/?page=garden');
    const bar = page.getByTestId('streak-bar');
    await expect(bar).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('streak-bar-line')).toHaveText('🌱 12-day streak · best 12');
    await expect(bar).toHaveAttribute('aria-label', /12-day streak, best 12\. Water something today/);
    const box = (await bar.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(28);
    expect(box.width).toBeLessThanOrEqual(size.viewport.width);
    await expect(bar.locator('svg')).toHaveCount(7);

    if (process.env.THEME_SCREENS) {
      mkdirSync(OUT, { recursive: true });
      for (const theme of THEMES) {
        await page.evaluate((t) => localStorage.setItem('anan.theme', t), theme);
        await page.reload();
        await expect(page.getByTestId('streak-bar')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(300);
        const shot = (await page.getByTestId('streak-bar').boundingBox())!;
        await page.screenshot({
          path: path.join(OUT, `${theme}-${size.name}-streak-bar.png`),
          clip: { x: 0, y: Math.max(0, shot.y - 60), width: size.viewport.width, height: shot.height + 120 },
        });
      }
    }

    await page.getByTestId('streak-bar').click();
    await expect(page.getByTestId('streak')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('streak')).toContainText('Current run: 12 days · best 12');
  });
}
