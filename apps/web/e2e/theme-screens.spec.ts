import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 22: screenshots of the main screens in both themes at phone and desktop size, saved to
 * docs/theme-screens/ for the owner to look at. Run with `THEME_SCREENS=1 pnpm exec playwright
 * test theme-screens --project=desktop` (skipped otherwise, so CI stays quick).
 */

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/theme-screens',
);
const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
] as const;
const THEMES = ['light', 'dark'] as const;
const SCREENS = [
  { id: 'home', route: 'garden', ready: 'now-studying' },
  { id: 'review', route: 'review', ready: 'review-counts' },
  { id: 'cloze', route: 'cloze', ready: null },
  { id: 'chat', route: 'chat', ready: null },
  { id: 'journal', route: 'journal', ready: null },
  { id: 'textbook', route: 'textbook', ready: null },
] as const;

type Handle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

/** A few words in each state, two of them due now, so Home shows its buttons and the garden grows. */
async function seed(page: Page) {
  await page.goto('/?page=garden');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await page.evaluate(async () => {
    const now = Date.now();
    const day = 86_400_000;
    const rows = [
      ['tocfl-7c491838af', -2, 3, 3],
      ['tocfl-29992340ae', -1, 2, 2],
      ['tocfl-3361e60084', 5, 30, 4],
      ['tocfl-64e19ba0ac', 9, 12, 5],
      ['tocfl-a844cb0bd2', 2, 4, 1],
    ].map(([id, dueDays, stability, reps]) => ({
      pk: `word:${id}:recognition`,
      item: { kind: 'word', id },
      skill: 'recognition',
      card: {
        due: new Date(now + (dueDays as number) * day),
        stability,
        difficulty: 5,
        elapsed_days: 3,
        scheduled_days: 5,
        learning_steps: 0,
        reps,
        lapses: 0,
        state: 2,
        last_review: new Date(now - 3 * day),
      },
      state: (stability as number) >= 21 ? 'mature' : 'review',
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      clozeRung: 1,
      clozeStreak: 0,
      familiarity: 0,
      readingDependence: 0,
      flags: {},
      updatedAt: new Date(now),
    }));
    await (window as unknown as { __anan: Handle }).__anan.db.items.bulkPut(rows);
  });
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`theme screenshots: ${theme}, ${size.name}`, async ({ page }) => {
      test.skip(!process.env.THEME_SCREENS, 'set THEME_SCREENS=1 to refresh docs/theme-screens/');
      test.setTimeout(120_000);
      mkdirSync(OUT, { recursive: true });
      await page.setViewportSize(size.viewport);
      await page.addInitScript((t) => {
        localStorage.setItem('anan.theme', t);
        localStorage.removeItem('anan.study.disabled');
      }, theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await seed(page);
      for (const s of SCREENS) {
        await page.goto(`/?page=${s.route}`);
        await expect(page.locator('.page-slot .page-loading')).toHaveCount(0, { timeout: 20_000 });
        if (s.ready)
          await expect(page.getByTestId(s.ready).first()).toBeVisible({ timeout: 20_000 });
        else
          await expect(page.locator('.page-slot h1, .page-slot h2').first()).toBeVisible({
            timeout: 20_000,
          });
        await page.waitForTimeout(600);
        await page.screenshot({
          path: path.join(OUT, `${theme}-${size.name}-${s.id}.png`),
          fullPage: s.id !== 'home',
        });
        if (s.id === 'home') {
          // the garden plots further down Home
          await page.screenshot({
            path: path.join(OUT, `${theme}-${size.name}-garden.png`),
            fullPage: true,
          });
        }
      }
    });
  }
}
