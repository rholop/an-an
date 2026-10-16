import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 43 Test 8 (owner, 2026-10-16: "having 100 cards to review is just so discouraging"): Review
 * runs in blocks by card type, holds at most 40 cards and says how many more wait, and once the
 * session's first answer is in, no new card joins it. The fixture puts the profile in its evening
 * session, so the rest waits for tomorrow morning.
 */

type AnanHandle = { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } };

// Real word ids (a card the word list can't show is held, Phase 38).
const lexicon = JSON.parse(readFileSync(fileURLToPath(new URL('../public/lexicon/lexicon.v2.json', import.meta.url)), 'utf8')) as {
  words?: { id: string; source: string }[];
};
const IDS = (Array.isArray(lexicon) ? (lexicon as { id: string; source: string }[]) : (lexicon.words ?? []))
  .filter((w) => w.source === 'tocfl')
  .slice(0, 60)
  .map((w) => w.id);

/** Recognition cards: answered before and due a minute ago, or New (introduced, never answered). */
async function seedCards(page: Page, ids: string[], kind: 'due' | 'new') {
  await page.evaluate(
    async ({ list, kind }) => {
      const now = Date.now();
      const fresh = kind === 'new';
      await (window as unknown as { __anan: AnanHandle }).__anan.db.items.bulkPut(
        list.map((id) => ({
          pk: `word:${id}:recognition`,
          item: { kind: 'word', id },
          skill: 'recognition',
          card: fresh
            ? { due: new Date(now), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 }
            : {
                due: new Date(now - 60_000),
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
          state: fresh ? 'introduced' : 'review',
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
    { list: ids, kind },
  );
}

async function openReview(page: Page) {
  await page.goto('/?page=review');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
}

async function counts(page: Page): Promise<{ due: number; fresh: number }> {
  const text = await page.getByTestId('review-counts').innerText();
  const m = /^(\d+) due · (\d+) new/.exec(text);
  if (!m) throw new Error(`unexpected counts: ${text}`);
  return { due: Number(m[1]), fresh: Number(m[2]) };
}

test.describe('laptop (1280 px)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('45 due cards: the session holds 40 in a Meaning block and says 5 more wait', async ({ page }) => {
    await openReview(page);
    await seedCards(page, IDS.slice(0, 45), 'due');
    await openReview(page);
    await expect(page.getByTestId('review-counts')).toContainText(/^40 due · 0 new/);
    await expect(page.getByTestId('review-block')).toHaveText('Meaning · 40');
    await expect(page.getByTestId('review-waiting')).toHaveText('5 more are waiting for tomorrow morning');
  });
});

test.describe('phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('after the first answer no new card joins the session', async ({ page }) => {
    await openReview(page);
    await seedCards(page, IDS.slice(45, 50), 'due');
    await seedCards(page, IDS.slice(50, 53), 'new');
    await openReview(page);
    await expect(page.getByTestId('review-block')).toBeVisible();
    await expect(page.getByTestId('review-counts')).toContainText(/^\d+ due · \d+ new/);
    const before = await counts(page);
    expect(before.due).toBe(5);

    await page.getByRole('button', { name: 'Show answer' }).first().click();
    await page.getByRole('button', { name: 'Easy' }).click();
    await expect.poll(async () => { const c = await counts(page); return c.due + c.fresh; }).toBe(before.due + before.fresh - 1);

    // a new word arrives after the session started: it waits for the next session
    await seedCards(page, IDS.slice(53, 54), 'new');
    await openReview(page);
    await expect(page.getByTestId('review-counts')).toContainText(/^\d+ due · \d+ new/);
    const after = await counts(page);
    expect(after.fresh).toBeLessThanOrEqual(before.fresh);
    expect(after.due + after.fresh).toBe(before.due + before.fresh - 1);
  });
});
