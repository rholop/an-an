import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 23 Parts B and C: Review's Pick the Mandarin face, and the Pinyin & tones tab played
 * through by tap on a phone-sized screen.
 */

type AnanHandle = {
  db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown>; toArray: () => Promise<{ skill: string; card: { reps: number } }[]> } };
};

const IDS = {
  老師: 'tocfl-e6e5696c01',
  學生: 'tocfl-df11d6ee67',
  朋友: 'tocfl-79b6361089',
  喜歡: 'tocfl-8cca6ed256',
  電話: 'tocfl-c128a92442',
  咖啡: 'tocfl-7c491838af',
  手機: 'tocfl-8e37d8babc',
  學校: 'tocfl-d44d3a4900',
  可以: 'tocfl-76fa79162a',
  一起: 'tocfl-2d03bda470',
  不要: 'moec-8bdd8b8fa5',
  吃: 'tocfl-29992340ae',
  喝: 'tocfl-3361e60084',
  茶: 'tocfl-4ff50dae17',
  水: 'tocfl-f3c1948845',
  書: 'tocfl-2580412342',
  買: 'tocfl-d9c66f870a',
  賣: 'tocfl-fbf730c857',
};

/** Cards answered before (FSRS Review state); `dueIn` ms from now (negative = due now). */
async function seed(page: Page, rows: { id: string; skill: string; dueIn: number; stability?: number }[]) {
  await page.evaluate(async (list) => {
    const now = Date.now();
    await (window as unknown as { __anan: AnanHandle }).__anan.db.items.bulkPut(
      list.map(({ id, skill, dueIn, stability }) => ({
        pk: `word:${id}:${skill}`,
        item: { kind: 'word', id },
        skill,
        card: {
          due: new Date(now + dueIn),
          stability: stability ?? 4,
          difficulty: 5,
          elapsed_days: 2,
          scheduled_days: 4,
          learning_steps: 0,
          reps: 3,
          lapses: 0,
          state: 2,
          last_review: new Date(now - 4 * 86_400_000),
        },
        state: 'review',
        lapses: 0,
        leech: false,
        leechTreatmentsTried: [],
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

test('Review: Pick the Mandarin shows 4 same-length look-alikes; a right pick rates Hard or Good, a wrong one shows all four', async ({ page }) => {
  await open(page, 'review');
  const later = 30 * 86_400_000;
  // a production card due now (on the Pick rung), every other card of the words not due
  await seed(page, [
    { id: IDS.老師, skill: 'recognition', dueIn: later },
    { id: IDS.老師, skill: 'production', dueIn: -60_000, stability: 2 },
    { id: IDS.學生, skill: 'recognition', dueIn: later },
    { id: IDS.學生, skill: 'production', dueIn: -60_000, stability: 2 },
    ...[IDS.朋友, IDS.喜歡, IDS.電話, IDS.咖啡, IDS.手機, IDS.學校].flatMap((id) => [
      { id, skill: 'recognition', dueIn: later },
      { id, skill: 'production', dueIn: later },
    ]),
    // every word's reading card exists already, so no new Say it card joins the session
    ...[IDS.老師, IDS.學生, IDS.朋友, IDS.喜歡, IDS.電話, IDS.咖啡, IDS.手機, IDS.學校].map((id) => ({ id, skill: 'reading', dueIn: later })),
  ]);
  await open(page, 'review');
  const card = page.getByTestId('review-card');
  await expect(card).toHaveAttribute('data-face', 'pick');
  await expect(page.getByTestId('review-face')).toHaveText('Pick the Mandarin');
  const options = page.getByTestId('review-pick-option');
  await expect(options).toHaveCount(4);
  const lengths = await options.locator('.review-pick-zh').allInnerTexts();
  expect(new Set(lengths.map((t) => [...t].length)).size).toBe(1);
  await expect(page.locator('[data-testid="review-pick-option"][data-right="true"]')).toHaveCount(1);

  // right pick: Hard or Good, never Easy
  await page.locator('[data-testid="review-pick-option"][data-right="true"]').click();
  await expect(page.getByTestId('review-pick-result')).toHaveText('✓ Correct');
  await expect(page.getByRole('button', { name: 'Easy' })).toHaveCount(0);
  await expect(options.first().locator('.review-pick-info')).toBeVisible();
  await page.getByRole('button', { name: 'Good' }).click();

  // the second card: a wrong pick shows all four with pinyin and meaning, then Next
  await expect(card).toHaveAttribute('data-face', 'pick');
  await page.locator('[data-testid="review-pick-option"]:not([data-right])').first().click();
  await expect(page.getByTestId('review-pick-result')).toContainText('Not quite');
  await expect(page.locator('.review-pick-info')).toHaveCount(4);
  await page.getByTestId('review-pick-next').click();
});

test.describe('Pinyin & tones on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the tab is in More; every exercise works by tap, 一 / 不 / 3+3 notes show, and reading cards are scheduled', async ({ page }) => {
    test.setTimeout(90_000);
    await open(page, 'garden');
    const later = 30 * 86_400_000;
    const ids = Object.values(IDS);
    await seed(page, [
      ...ids.map((id) => ({ id, skill: 'recognition', dueIn: later })),
      ...ids.map((id) => ({ id, skill: 'reading', dueIn: -60_000 })),
    ]);
    await open(page, 'garden');
    // phones: the tab is in the More sheet
    await page.getByRole('button', { name: /More/ }).click();
    await page.getByRole('button', { name: 'Pinyin & tones' }).click();
    await expect(page.getByRole('heading', { name: 'Pinyin & tones' })).toBeVisible();

    const kinds = new Set<string>();
    let notes = 0;
    for (let step = 0; step < 40; step++) {
      const ex = page.getByTestId('pinyin-exercise');
      const summary = page.getByTestId('pinyin-summary');
      await expect(ex.or(summary).first()).toBeVisible();
      if (await summary.isVisible()) break;
      const kind = (await ex.getAttribute('data-kind'))!;
      kinds.add(kind);
      if (kind === 'tones') {
        const syllables = ex.getByTestId('pinyin-syllable');
        for (let i = 0; i < (await syllables.count()); i++)
          await syllables.nth(i).locator('[data-testid="pinyin-tone"][data-right="true"]').tap();
        await page.getByTestId('pinyin-check').tap();
      } else if (kind === 'match') {
        const words = ex.getByTestId('pinyin-match-word');
        for (let i = 0; i < (await words.count()); i++) {
          const id = await words.nth(i).getAttribute('data-id');
          await words.nth(i).tap();
          await ex.locator(`[data-testid="pinyin-match-reading"][data-id="${id}"]`).tap();
        }
      } else if (kind === 'chars' || kind === 'lookalike') {
        await expect(ex.getByTestId('pinyin-pick-option')).toHaveCount(4);
        await ex.locator('[data-testid="pinyin-pick-option"][data-right="true"]').tap();
      } else if (kind === 'which') {
        await expect(ex.getByTestId('pinyin-which-option')).toHaveCount(2);
        await ex.locator('[data-testid="pinyin-which-option"][data-right="true"]').tap();
      } else if (kind === 'sort') {
        const rows = ex.getByTestId('pinyin-sort-row');
        await expect(rows).toHaveCount(6);
        for (let i = 0; i < 6; i++) await rows.nth(i).locator('[data-testid="pinyin-sort-pattern"][data-right="true"]').tap();
        await page.getByTestId('pinyin-check').tap();
      } else if (kind === 'type') {
        // a wrong answer: graded, and the right reading is shown
        await ex.getByTestId('pinyin-type-input').fill('ma1');
        await page.getByTestId('pinyin-check').tap();
      }
      await expect(page.getByTestId('pinyin-result')).toBeVisible();
      if (kind !== 'type') await expect(page.getByTestId('pinyin-result')).toHaveText('✓ Correct');
      notes += await page.getByTestId('sandhi-note').count();
      await page.getByTestId('pinyin-next').tap();
    }
    await expect(page.getByTestId('pinyin-summary')).toBeVisible();
    // the grids every session has, and singles from the rotation (tones, type, which, chars, look-alikes)
    for (const k of ['match', 'sort']) expect(kinds).toContain(k);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(notes).toBeGreaterThan(0);

    // reading cards were answered and scheduled ahead; recognition untouched
    const rows = await page.evaluate(() => (window as unknown as { __anan: AnanHandle }).__anan.db.items.toArray());
    expect(rows.filter((r) => r.skill === 'reading' && r.card.reps > 3).length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.skill === 'recognition' && r.card.reps !== 3)).toEqual([]);

    // Progress: the tone table and "Pinyin X%" next to Learned · Mastered
    await page.goto('/?page=progress');
    await expect(page.getByTestId('progress-all')).toContainText(/Learned \d+% · Mastered \d+% · Pinyin \d+%/);
  });
});
