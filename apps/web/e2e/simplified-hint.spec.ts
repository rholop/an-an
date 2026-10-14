import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 41: small simplified characters above the traditional word, on flashcards only. Meaning
 * and Say it show it from the start, Pick and Recall only with the answer, only when it differs,
 * and Settings → Review can turn it off.
 */

const IDS = {
  餅乾: 'tocfl-11393ea18d',
  可以: 'tocfl-76fa79162a',
  簡單: 'tocfl-aa7e539731',
  喜歡: 'tocfl-8cca6ed256',
  老師: 'tocfl-e6e5696c01',
  學生: 'tocfl-df11d6ee67',
  朋友: 'tocfl-79b6361089',
  電話: 'tocfl-c128a92442',
  咖啡: 'tocfl-7c491838af',
  手機: 'tocfl-8e37d8babc',
  學校: 'tocfl-d44d3a4900',
};
const DAY = 86_400_000;

type Row = { id: string; skill: string; dueIn: number; prodRung?: 'pick' | 'recall' };
type Handle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

async function seed(page: Page, rows: Row[]) {
  await page.evaluate(async (list) => {
    const now = Date.now();
    await (window as unknown as { __anan: Handle }).__anan.db.items.bulkPut(
      list.map(({ id, skill, dueIn, prodRung }) => ({
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
          lapses: 0,
          state: 2,
          last_review: new Date(now - 4 * 86_400_000),
        },
        ...(prodRung ? { prodRung, prodStreak: 0 } : {}),
        state: 'review',
        lapses: 0,
        leech: false,
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

const hint = (page: Page) => page.getByTestId('review-card').getByTestId('simplified-hint');

test('Meaning: 餅乾 shows 饼干 above it from the start, 可以 shows nothing extra', async ({ page }) => {
  await seedDue(page, [
    { id: IDS.餅乾, skill: 'recognition', dueIn: -60_000 },
    { id: IDS.可以, skill: 'recognition', dueIn: -60_000 },
  ]);
  await open(page, 'review');
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const card = page.getByTestId('review-card');
    const front = card.locator('.review-card-front');
    await expect(front).toHaveText(/餅乾|可以/);
    const text = (await front.locator('.zh-hint-word').or(front).first().innerText()).trim();
    if ((await front.innerText()).includes('餅乾')) {
      seen.add('餅乾');
      await expect(hint(page)).toHaveText('饼干');
      await expect(hint(page)).toHaveAttribute('aria-hidden', 'true');
      // above the traditional word, small but never below 12 px
      const h = (await hint(page).boundingBox())!;
      const w = (await front.locator('.zh-hint-word').boundingBox())!;
      expect(h.y + h.height).toBeLessThanOrEqual(w.y + 1);
      const px = await hint(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(px).toBeGreaterThanOrEqual(12);
      expect(px).toBeLessThan(await front.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)));
    } else {
      seen.add('可以');
      expect(text).toContain('可以');
      // give the converter time to load, then still nothing
      await page.waitForTimeout(300);
      await expect(hint(page)).toHaveCount(0);
    }
    const handle = await card.elementHandle();
    await page.getByRole('button', { name: 'Show answer' }).click();
    await page.getByRole('button', { name: 'Good' }).click();
    if (handle) await page.waitForFunction((n) => !n.isConnected, handle);
  }
  expect([...seen].sort()).toEqual(['可以', '餅乾'].sort());
});

for (const rung of ['pick', 'recall'] as const) {
  test(`${rung === 'pick' ? 'Pick' : 'Recall'}: no simplified form before answering, then 简单 with the answer`, async ({ page }) => {
    await seedDue(page, [{ id: IDS.簡單, skill: 'production', dueIn: -60_000, prodRung: rung }]);
    await open(page, 'review');
    const card = page.getByTestId('review-card');
    await expect(card).toHaveAttribute('data-face', rung);
    await page.waitForTimeout(300);
    await expect(hint(page)).toHaveCount(0);
    await expect(card).not.toContainText('简单');
    if (rung === 'pick') {
      await card.locator('[data-testid="review-pick-option"][data-right="true"]').click();
      await expect(card.locator('[data-testid="review-pick-option"][data-right="true"]').getByTestId('simplified-hint')).toHaveText('简单');
    } else {
      await page.getByRole('button', { name: 'Show answer' }).click();
      await expect(page.getByTestId('review-back').getByTestId('simplified-hint')).toHaveText('简单');
    }
    await expect(hint(page)).toHaveCount(1);
  });
}

test('Say it shows the hint from the start; with the setting off nothing extra shows', async ({ page }) => {
  await seedDue(page, [
    { id: IDS.喜歡, skill: 'reading', dueIn: -60_000 },
    { id: IDS.簡單, skill: 'production', dueIn: -60_000, prodRung: 'recall' },
  ]);
  await open(page, 'review');
  const card = page.getByTestId('review-card');
  // whichever comes first: the Say it card shows 喜欢 at once
  if ((await card.getAttribute('data-face')) === 'say') await expect(hint(page)).toHaveText('喜欢');

  await open(page, 'review-settings');
  const box = page.getByTestId('show-simplified');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();

  await open(page, 'review');
  for (let i = 0; i < 2; i++) {
    const c = page.getByTestId('review-card');
    await expect(c).toBeVisible();
    const face = await c.getAttribute('data-face');
    if (face === 'say') await expect(c.locator('.review-card-front')).toHaveText('喜歡');
    await page.getByRole('button', { name: 'Show answer' }).click();
    await page.waitForTimeout(300);
    await expect(hint(page)).toHaveCount(0);
    const handle = await c.elementHandle();
    await page.getByRole('button', { name: 'Good' }).click();
    if (handle) await page.waitForFunction((n) => !n.isConnected, handle);
  }
});
