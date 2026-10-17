import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 44: every review card whose word has 2 or more characters shows each character with its
 * reading in this word and a short meaning, only once the answer is shown. One-character words show
 * nothing, leech cards keep their own panel, and Settings → Review can turn the everyday row off.
 */

const IDS = {
  餅乾: 'tocfl-11393ea18d',
  吃: 'tocfl-29992340ae',
  簡單: 'tocfl-aa7e539731',
  老師: 'tocfl-e6e5696c01',
  學生: 'tocfl-df11d6ee67',
  咖啡: 'tocfl-7c491838af',
};
const DAY = 86_400_000;

type Row = { id: string; skill: string; dueIn: number; prodRung?: 'pick' | 'recall'; leech?: boolean };
type Handle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

async function seed(page: Page, rows: Row[]) {
  await page.evaluate(async (list) => {
    const now = Date.now();
    await (window as unknown as { __anan: Handle }).__anan.db.items.bulkPut(
      list.map(({ id, skill, dueIn, prodRung, leech }) => ({
        pk: `word:${id}:${skill}`,
        item: { kind: 'word', id },
        skill,
        card: {
          due: new Date(now + dueIn),
          stability: 4,
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 4,
          learning_steps: 0,
          reps: 3,
          lapses: leech ? 8 : 0,
          state: 2,
          last_review: new Date(now - 4 * 86_400_000),
        },
        ...(prodRung ? { prodRung, prodStreak: 0 } : {}),
        state: 'review',
        lapses: leech ? 8 : 0,
        leech: Boolean(leech),
        leechTreatmentsTried: [],
        clozeRung: 1,
        clozeStreak: 0,
        familiarity: 0,
        readingDependence: 0,
        flags: {},
        updatedAt: new Date(now),
      })),
    );
  }, rows);
}

async function open(page: Page, route: string) {
  await page.goto(`/?page=${route}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

/** Every word answered before and not due, then the given cards due now. */
async function seedDue(page: Page, due: Row[]) {
  await open(page, 'garden');
  await seed(page, [
    ...Object.values(IDS).flatMap((id) =>
      ['recognition', 'production', 'reading'].map((skill) => ({ id, skill, dueIn: 30 * DAY })),
    ),
    ...due,
  ]);
}

const breakdown = (page: Page) => page.getByTestId('review-card').getByTestId('char-breakdown');

/** Opens the row if a short window started it collapsed. */
async function openRow(page: Page) {
  const toggle = breakdown(page).locator('.char-panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

for (const width of [1280, 390]) {
  test(`Meaning at ${width} px: 餅乾 shows 餅 and 乾 with readings and meanings after reveal, nothing before`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 650 });
    await seedDue(page, [{ id: IDS.餅乾, skill: 'recognition', dueIn: -60_000 }]);
    await open(page, 'review');
    const card = page.getByTestId('review-card');
    await expect(card).toHaveAttribute('data-face', 'meaning');
    await expect(breakdown(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show answer' }).click();
    await expect(breakdown(page)).toBeVisible();
    await expect(breakdown(page)).toContainText('Characters');
    await expect(breakdown(page)).not.toHaveClass(/leech-panel/);
    await openRow(page);
    const tiles = breakdown(page).getByTestId('char-tile');
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0)).toContainText('餅');
    await expect(tiles.nth(0)).toContainText('bǐng');
    await expect(tiles.nth(0).getByTestId('char-gloss')).toHaveText('round flat cake');
    await expect(tiles.nth(1)).toContainText('乾');
    await expect(tiles.nth(1)).toContainText('gān');
    await expect(tiles.nth(1).getByTestId('char-gloss')).toHaveText('dry');
    await expect(breakdown(page)).not.toContainText('not its own lexicon entry');
  });
}

test('a one-character word (吃) shows no breakdown', async ({ page }) => {
  await seedDue(page, [{ id: IDS.吃, skill: 'recognition', dueIn: -60_000 }]);
  await open(page, 'review');
  await expect(page.getByTestId('review-card').locator('.review-card-front')).toContainText('吃');
  await page.getByRole('button', { name: 'Show answer' }).click();
  await expect(page.getByTestId('review-back')).toBeVisible();
  await expect(breakdown(page)).toHaveCount(0);
});

for (const rung of ['pick', 'recall'] as const) {
  test(`${rung === 'pick' ? 'Pick' : 'Recall'}: nothing until answered, then 簡 and 單`, async ({ page }) => {
    await seedDue(page, [{ id: IDS.簡單, skill: 'production', dueIn: -60_000, prodRung: rung }]);
    await open(page, 'review');
    const card = page.getByTestId('review-card');
    await expect(card).toHaveAttribute('data-face', rung);
    await expect(breakdown(page)).toHaveCount(0);
    await expect(card).not.toContainText('jiǎn');
    if (rung === 'pick') await card.locator('[data-testid="review-pick-option"][data-right="true"]').click();
    else await page.getByRole('button', { name: 'Show answer' }).click();
    await expect(breakdown(page)).toBeVisible();
    await openRow(page);
    await expect(breakdown(page).getByTestId('char-tile')).toHaveText([/簡/, /單/]);
  });
}

test('a leech keeps its panel and title; with the setting off only leeches show a breakdown', async ({ page }) => {
  await seedDue(page, [
    { id: IDS.老師, skill: 'recognition', dueIn: -60_000, leech: true },
    { id: IDS.學生, skill: 'recognition', dueIn: -60_000 },
  ]);
  await open(page, 'review-settings');
  const box = page.getByTestId('show-char-meanings');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();

  await open(page, 'review');
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const card = page.getByTestId('review-card');
    const front = (await card.locator('.review-card-front').innerText()).trim();
    await page.getByRole('button', { name: 'Show answer' }).click();
    await expect(page.getByTestId('review-back')).toBeVisible();
    if (front.includes('老師')) {
      seen.add('老師');
      await expect(breakdown(page)).toHaveClass(/leech-panel/);
      await expect(breakdown(page)).toContainText('Leech — character breakdown');
      await openRow(page);
      await expect(breakdown(page).getByTestId('char-tile')).toHaveCount(2);
    } else {
      seen.add('學生');
      await expect(breakdown(page)).toHaveCount(0);
    }
    const handle = await card.elementHandle();
    await page.getByRole('button', { name: 'Good' }).click();
    if (handle) await page.waitForFunction((n) => !n.isConnected, handle);
  }
  expect([...seen].sort()).toEqual(['學生', '老師'].sort());
});
