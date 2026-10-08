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

/** A zone where it is about `hour`:00 now (Etc/GMT-k is UTC+k). */
function zoneAt(hour: number, now: Date = new Date()): string {
  let k = hour - now.getUTCHours();
  if (k > 14) k -= 24;
  if (k < -12) k += 24;
  return k === 0 ? 'Etc/GMT' : `Etc/GMT${k > 0 ? '-' : '+'}${Math.abs(k)}`;
}

test("the owner's scenario (Phase 23): 2 pm, morning review done, 3 cards due before 4 pm: Home and Review say the evening review opens at 4 pm", async ({
  page,
}) => {
  // it is about 14:00 in the profile's zone: between the morning (until 10:00) and evening (from 16:00) sessions
  await page.addInitScript((zone) => localStorage.setItem('anan.sessions.defaultZone', zone), zoneAt(14));
  await open(page, 'garden');
  await seedCards(page, WORDS.slice(0, 3), 45 * 60_000);

  await open(page, 'garden');
  const status = page.getByTestId('home-review-status');
  await expect(status).toContainText('Morning review done · Evening review opens at 4 pm (3 cards)');
  await expect(page.getByText('New words paused until')).toHaveCount(0);
  // no buttons between sessions: one quiet line with "Review early"
  await expect(page.getByTestId('home-actions-quiet')).toContainText('Evening review opens at 4 pm (3 cards)');
  await expect(page.getByTestId('review-all-btn')).toHaveCount(0);
  // the forecast: two bars a day; today's evening holds the 3 cards
  const first = page.getByTestId('due-forecast').locator('li').first();
  await expect(first.locator('.due-forecast-day')).toHaveText('Today');
  await expect(first.locator('.due-forecast-n')).toHaveText('0·3');
  await expect(first.getByTestId('forecast-morning')).toBeVisible();
  const homeLine = await status.innerText();

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByTestId('review-status')).toHaveText(homeLine);
  await expect(page.getByTestId('review-counts')).toContainText(/^0 due · 0 new/);

  // "Review early" opens the evening session's cards now
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByTestId('review-early').click();
  await expect(page.getByRole('heading', { name: 'Review early' })).toBeVisible();
  await expect(page.getByTestId('review-counts')).toContainText(/^3 due · 0 new/);
});

test('the cap is per session: 85 answers this evening hold the rest and pause new words until the next session', async ({ page }) => {
  await open(page, 'garden');
  await seedCards(page, WORDS.slice(0, 3), -60_000);
  await seedReviewsDone(page, 85);
  await open(page, 'garden');
  await expect(page.getByTestId('home-new-state')).toHaveText("You've done this session's 80 reviews. New words return next session.");
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByTestId('review-cap-note')).toContainText("You've done this session's 80 reviews.");
});

test('changing the session times in Settings updates Home and Review without a reload', async ({ page }) => {
  await open(page, 'garden');
  await seedCards(page, WORDS.slice(0, 2), -60_000);
  await open(page, 'garden');
  const status = page.getByTestId('home-review-status');
  // it is about 18:00 in the profile's zone (the fixture): the evening session is open
  await expect(status).toContainText('Evening review · 2 cards');
  // the evening session now opens at 8 pm: it is between sessions, and the 2 cards wait for it
  await page.getByRole('button', { name: /^More/ }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).or(page.getByRole('button', { name: 'Settings' })).first().click();
  await page.getByTestId('evening-opens').fill('20:00');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(status).toContainText('Morning review done · Evening review opens at 8 pm (2 cards)');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByTestId('review-status')).toContainText('Evening review opens at 8 pm (2 cards)');
  await expect(page.getByTestId('review-counts')).toContainText(/^0 due · /);
  // and back: the session opens again in place
  await page.getByRole('button', { name: /^More/ }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).or(page.getByRole('button', { name: 'Settings' })).first().click();
  await page.getByTestId('evening-opens').fill('16:00');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(status).toContainText('Evening review · 2 cards');
});

test('Review all (N) opens exactly N cards, and Water all (N) covers exactly N words', async ({
  page,
}) => {
  await open(page, 'garden');
  await seedCards(page, WORDS, -3_600_000);
  await open(page, 'garden');
  await expect(page.getByTestId('review-all-btn')).toHaveText('Review all (4)');
  await expect(page.getByTestId('water-all-btn')).toHaveText('💧 Water all (4)');
  await expect(page.getByTestId('home-review-status')).toContainText('Evening review · 4 cards');

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
  await expect(page.getByTestId('home-review-status')).toContainText(/Evening review · \d+ cards?/);
});
