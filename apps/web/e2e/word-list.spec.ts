import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 38: the owner saw "(unknown item)" review cards: the browser kept an old word list (Cache
 * First, one URL forever) while book.json was fresh. Now the data files have content-hashed names
 * from data-manifest.json. Here a browser starts with an old word list that lacks 咖啡, holding a
 * due 咖啡 card: Review says it is waiting for the word list (never "(unknown item)"); after a new
 * build is deployed, the manifest check brings the new list in and the card shows, with no reload.
 */

const COFFEE = 'tocfl-7c491838af'; // 咖啡
const OLD = 'lexicon/lexicon.v2.0000000aaa.json';
const NEW = 'lexicon/lexicon.v2.0000000bbb.json';

async function serveBuilds(page: Page, build: { current: string }) {
  const full = (await (await page.request.get('/lexicon/lexicon.v2.json')).json()) as { words: { id: string }[] };
  const old = { ...full, words: full.words.filter((w) => w.id !== COFFEE) };
  const manifest = (await (await page.request.get('/data-manifest.json')).json()) as { files: Record<string, string> };
  await page.route('**/data-manifest.json', (route: Route) =>
    route.fulfill({ json: { ...manifest, files: { ...manifest.files, 'lexicon/lexicon.v2.json': build.current } } }),
  );
  await page.route(`**/${OLD}`, (route) => route.fulfill({ json: old }));
  await page.route(`**/${NEW}`, (route) => route.fulfill({ json: full }));
}

async function seedDueCoffee(page: Page) {
  await page.evaluate(async (id) => {
    const now = Date.now();
    await (window as unknown as { __anan: { db: { items: { put: (r: unknown) => Promise<unknown> } } } }).__anan.db.items.put({
      pk: `word:${id}:recognition`,
      item: { kind: 'word', id },
      skill: 'recognition',
      card: {
        due: new Date(now - 3_600_000),
        stability: 4,
        difficulty: 5,
        elapsed_days: 4,
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
      updatedAt: new Date(now - 4 * 86_400_000),
    });
  }, COFFEE);
}

test('a stale word list holds the card; the new build shows it after the manifest check, no reload', async ({ page }) => {
  const build = { current: OLD };
  await serveBuilds(page, build);
  await page.goto('/?page=home');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await seedDueCoffee(page);

  await page.goto('/?page=review');
  await expect(page.getByTestId('review-waiting-word-list')).toHaveText(/1 card is waiting for the latest word list · Reload/);
  await expect(page.getByTestId('review-card')).toHaveCount(0);
  await expect(page.getByText('(unknown item)')).toHaveCount(0);

  // deploy: a new build; the open app checks the manifest when it comes back to the foreground
  build.current = NEW;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('review-waiting-word-list')).toHaveCount(0);
  await expect(page.locator('.review-card-front')).toHaveText('咖啡');
});

test('Reload fetches the word list again, bypassing caches', async ({ page }) => {
  const build = { current: OLD };
  await serveBuilds(page, build);
  await page.goto('/?page=home');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await seedDueCoffee(page);
  await page.goto('/?page=review');
  await expect(page.getByTestId('review-waiting-word-list')).toBeVisible();
  build.current = NEW;
  await page.getByTestId('review-reload-word-list').click();
  await expect(page.locator('.review-card-front')).toHaveText('咖啡');
});
