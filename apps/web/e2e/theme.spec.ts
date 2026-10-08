import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
/** The page background: `color-scheme` paints the browser's Canvas colour (the body itself is transparent). */
const canvas = (page: Page) =>
  page.evaluate(() => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'Canvas';
    document.body.appendChild(el);
    const v = getComputedStyle(el).backgroundColor;
    el.remove();
    return v;
  });
const colorScheme = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });

/** Perceived brightness 0–255 of an `rgb(r, g, b)` string. */
const brightness = (rgb: string) => {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return 0.299 * r! + 0.587 * g! + 0.114 * b!;
};

test.describe('light / dark theme toggle', () => {
  test('Dark and Light force a theme regardless of the device setting, and Auto follows the device', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?page=reader');
    await expect(page.getByRole('radiogroup', { name: 'Colour theme' })).toBeVisible({
      timeout: 15000,
    });
    // default: Auto, no forced attribute
    await expect(radio(page, 'Auto')).toHaveAttribute('aria-checked', 'true');
    expect(await theme(page)).toBeNull();
    expect(brightness(await canvas(page))).toBeGreaterThan(200);

    await radio(page, 'Dark').click();
    await expect(radio(page, 'Dark')).toHaveAttribute('aria-checked', 'true');
    expect(await theme(page)).toBe('dark');
    expect(await colorScheme(page)).toBe('dark');
    expect(brightness(await canvas(page))).toBeLessThan(60);
    // the text colour flips too, so words stay readable
    await expect
      .poll(async () => brightness(await page.evaluate(() => getComputedStyle(document.body).color)))
      .toBeGreaterThan(140); // Solarized Dark body text (#93a1a1)

    // device dark + Light forced = light
    await page.emulateMedia({ colorScheme: 'dark' });
    await radio(page, 'Light').click();
    expect(await theme(page)).toBe('light');
    expect(await colorScheme(page)).toBe('light');
    expect(brightness(await canvas(page))).toBeGreaterThan(200);

    // Auto again: attribute gone, the device decides (dark now)
    await radio(page, 'Auto').click();
    expect(await theme(page)).toBeNull();
    expect(await colorScheme(page)).toBe('light dark');
    expect(brightness(await canvas(page))).toBeLessThan(60); // the device is dark
  });

  test('the choice survives a reload and is applied before the app renders', async ({ page }) => {
    await page.goto('/?page=reader');
    await expect(radio(page, 'Dark')).toBeVisible({ timeout: 15000 });
    await radio(page, 'Dark').click();
    await page.reload();
    // inline script in index.html: set before React mounts
    expect(await theme(page)).toBe('dark');
    await expect(radio(page, 'Dark')).toHaveAttribute('aria-checked', 'true');
    await radio(page, 'Auto').click();
    await page.reload();
    expect(await theme(page)).toBeNull();
    await expect(radio(page, 'Auto')).toHaveAttribute('aria-checked', 'true');
  });

  test('level colours stay readable in dark mode (lighter variants, not the light-mode ones)', async ({
    page,
  }) => {
    await page.goto('/?page=reader');
    await expect(radio(page, 'Dark')).toBeVisible({ timeout: 15000 });
    const colourOfLevel = async (cls: string) =>
      page.evaluate((c) => {
        const el = document.createElement('span');
        el.className = c;
        document.body.appendChild(el);
        const v = getComputedStyle(el).color;
        el.remove();
        return v;
      }, cls);
    await radio(page, 'Light').click();
    const light = await colourOfLevel('level-l5'); // dark brown in light mode
    await radio(page, 'Dark').click();
    const dark = await colourOfLevel('level-l5');
    expect(brightness(light)).toBeLessThan(90);
    expect(brightness(dark)).toBeGreaterThan(140); // legible on a near-black page
  });
});
