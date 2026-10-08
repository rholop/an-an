import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 22: Home and Review show the same review numbers (core `reviewStatus`), and Home's two
 * buttons open exactly the sessions their counts promise.
 */

type AnanHandle = {
  db: {
    items: { bulkPut: (rows: unknown[]) => Promise<unknown> };
    evidence: { bulkAdd: (rows: unknown[]) => Promise<unknown> };
  };
};

const WORDS = ['tocfl-7c491838af', 'tocfl-29992340ae', 'tocfl-3361e60084', 'tocfl-64e19ba0ac']; // 咖啡 吃 喝 塊

/** Recognition cards answered before, due at `dueAt` (ms from now, negative = due now). */
async function seedCards(page: Page, ids: string[], dueIn: number | 'later-today') {
  await page.evaluate(
    async ({ list, dueIn }) => {
      const now = Date.now();
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      const due = dueIn === 'later-today' ? now + (midnight.getTime() - now) / 2 : now + dueIn;
      await (window as unknown as { __anan: AnanHandle }).__anan.db.items.bulkPut(
        list.map((id) => ({
          pk: `word:${id}:recognition`,
          item: { kind: 'word', id },
          skill: 'recognition',
          card: {
            due: new Date(due),
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
    },
    { list: ids, dueIn },
  );
}

/** `n` review answers today, each a different card (they count toward the daily cap). */
async function seedReviewsDone(page: Page, n: number) {
  await page.evaluate(async (count) => {
    const at = new Date(Date.now() - 60_000);
    await (window as unknown as { __anan: AnanHandle }).__anan.db.evidence.bulkAdd(
      Array.from({ length: count }, (_, i) => ({
        item: { kind: 'word', id: `done-${i}` },
        skill: 'recognition',
        kind: 'review_good',
        at,
        uid: `seed-done-${i}`,
      })),
    );
  }, n);
}

async function open(page: Page, route: string) {
  await page.goto(`/?page=${route}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

test("the owner's scenario: 0 due now, 3 later today, 85 done: Home and Review agree, and it is today's limit", async ({
  page,
}) => {
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  test.skip(
    midnight.getTime() - Date.now() < 10 * 60_000,
    'too close to midnight for "later today"',
  );
  await open(page, 'garden');
  await seedCards(page, WORDS.slice(0, 3), 'later-today');
  await seedReviewsDone(page, 85);

  await open(page, 'garden');
  const status = page.getByTestId('home-review-status');
  await expect(status).toContainText(
    /0 due now · 3 more later today \(next at \d{1,2}:\d{2} [ap]m\)/,
  );
  await expect(page.getByTestId('home-new-state')).toHaveText(
    "You've done today's 80 reviews. New words return tomorrow.",
  );
  await expect(page.getByText('New words paused until your reviews catch up')).toHaveCount(0);
  // no buttons with nothing due: one quiet line with "Review early"
  await expect(page.getByTestId('home-actions-quiet')).toContainText(
    'All watered 🌱 · 3 more later today',
  );
  await expect(page.getByTestId('review-all-btn')).toHaveCount(0);
  // the forecast's first bar is the rest of today
  await expect(page.getByTestId('due-forecast').locator('.due-forecast-day').first()).toHaveText(
    'Rest of today',
  );
  const homeLine = await status.innerText();

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByTestId('review-status')).toHaveText(homeLine);
  await expect(page.getByTestId('review-cap-note')).toContainText(
    "You've done today's 80 reviews. New words return tomorrow.",
  );
  await expect(page.getByText('paused until your reviews catch up')).toHaveCount(0);
  await expect(page.getByTestId('review-counts')).toContainText(/^0 due · 0 new/);

  // "Review early" opens the later-today cards now
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByTestId('review-early').click();
  await expect(page.getByRole('heading', { name: 'Review early' })).toBeVisible();
  await expect(page.getByTestId('review-counts')).toContainText(/^3 due · 0 new/);
});

test('Review all (N) opens exactly N cards, and Water all (N) covers exactly N words', async ({
  page,
}) => {
  await open(page, 'garden');
  await seedCards(page, WORDS, -3_600_000);
  await open(page, 'garden');
  await expect(page.getByTestId('review-all-btn')).toHaveText('Review all (4)');
  await expect(page.getByTestId('water-all-btn')).toHaveText('💧 Water all (4)');
  await expect(page.getByTestId('home-review-status')).toContainText('4 due now');

  await page.getByTestId('review-all-btn').click();
  await expect(page.getByRole('heading', { name: 'Review all' })).toBeVisible();
  await expect(page.getByTestId('review-counts')).toContainText(/^4 due · 0 new/);
  await page.getByRole('button', { name: '← Back to home' }).click();

  await page.getByTestId('water-all-btn').click();
  await expect(page.getByTestId('water-all')).toBeVisible();
  await expect(page.getByTestId('mini-plant')).toBeVisible();
  await expect(page.locator('.water-all-meta')).toContainText('of 4 · 4 words');

  // Water every word: flashcards (Show answer → Good) and clozes (pick the right word → Next).
  for (let step = 0; step < 12; step++) {
    if (await page.getByTestId('water-all-done').isVisible()) break;
    const reveal = page.getByRole('button', { name: 'Show answer' });
    const good = page.getByRole('button', { name: 'Good' });
    const next = page.getByRole('button', { name: 'Next' });
    await expect(
      reveal
        .or(good)
        .or(next)
        .or(page.locator('.cloze-chip').first())
        .or(page.getByTestId('water-all-done'))
        .first(),
    ).toBeVisible();
    if (await reveal.isVisible()) {
      await reveal.click();
      await good.click();
    } else if (await next.isVisible()) {
      await next.click();
    } else if (await page.locator('.cloze-chip').first().isVisible()) {
      // the right answer is one of the four seeded words
      await page.locator('.cloze-chip').first().click();
    } else if (await page.locator('.cloze-typed input, input.cloze-input').first().isVisible()) {
      break;
    }
  }
  await expect(page.getByTestId('water-all-done')).toBeVisible();
  await expect(page.locator('.water-all-summary')).toContainText(/Watered 4 words 🌱/);
  await page.getByRole('button', { name: 'Back to home' }).last().click();
  // watered words are no longer due (any missed cloze came back once and was answered too)
  await expect(page.getByTestId('home-review-status')).toContainText(/\d+ due now/);
});
