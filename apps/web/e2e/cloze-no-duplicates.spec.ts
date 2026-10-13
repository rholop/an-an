import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 37 (owner: "The cloze shows duplicate questions, basically 2 of each"): words with both
 * recognition and production due give one question each, and no two questions in one session
 * show the same sentence and blank, except "Again" retries. The start button counts words and
 * equals the number of questions asked.
 */

type AnanHandle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

// N1 words outside the textbook: 年 老 國 姓名 我們 中午
const W = ['tocfl-09b8af0618', 'tocfl-0c4cb5b280', 'tocfl-114c0d4299', 'tocfl-1697ecc50f', 'tocfl-1f6fbc0616', 'tocfl-20eacb253a'];

async function seed(page: Page) {
  await page.goto('/?page=garden');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await page.evaluate(async (ids) => {
    const anan = (window as unknown as { __anan: AnanHandle }).__anan;
    const now = Date.now();
    const yesterday = new Date(now - 86_400_000);
    const lastWeek = new Date(now - 7 * 86_400_000);
    await anan.db.items.bulkPut(
      ids.flatMap((id) =>
        (['recognition', 'production'] as const).map((skill) => ({
          pk: `word:${id}:${skill}`,
          item: { kind: 'word', id },
          skill,
          card: { due: yesterday, stability: 4, difficulty: 5, elapsed_days: 2, scheduled_days: 4, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: lastWeek },
          state: 'review',
          lapses: 0,
          leech: false,
          leechTreatmentsTried: [],
          clozeRung: 1,
          clozeStreak: 0,
          familiarity: 0,
          readingDependence: 0,
          flags: {},
          updatedAt: lastWeek,
        })),
      ),
    );
  }, W);
}

test('Cloze: one question per word, no sentence twice except Again retries', async ({ page }) => {
  test.setTimeout(60_000);
  await seed(page);
  await page.goto('/?page=cloze');
  const start = page.getByTestId('cloze-start');
  await expect(start).toBeVisible({ timeout: 15_000 });
  const label = await start.innerText();
  const words = Number(/\((\d+) words?/.exec(label)?.[1]);
  expect(words, label).toBeGreaterThanOrEqual(W.length);
  expect(words, label).toBeLessThan(W.length * 2);
  await start.click();

  const seen: string[] = [];
  for (let step = 0; step < 60; step++) {
    if (await page.getByRole('heading', { name: 'Session complete' }).isVisible()) break;
    const prompt = page.locator('.cloze-sentence, .cloze-prompt').first();
    await expect(prompt).toBeVisible();
    const again = await page.getByTestId('cloze-again').isVisible();
    if (!again) seen.push(await prompt.innerText());
    const chip = page.locator('.cloze-chip').first();
    if (await chip.isVisible()) await chip.click();
    else {
      await page.locator('.cloze-exercise input').first().fill('字');
      await page.keyboard.press('Enter');
    }
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible();
  expect(seen).toHaveLength(words);
  expect(new Set(seen).size, seen.join('\n')).toBe(seen.length);
});
