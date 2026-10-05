import { expect, test } from './fixtures.js';

// Phase 15: the Listen session. Nothing plays before a tap; "Sounds wrong" skips without penalty.
// The audio manifest and clips are gitignored build output (absent in CI), so the spec serves its own.
let ids: string[] = [];

test.beforeEach(async ({ page }) => {
  const res = await page.request.get('/lexicon/lexicon.v2.json');
  const lex = (await res.json()) as { words: { id: string; source: string; level: string | null; pinyinNumeric?: string }[] };
  ids = lex.words
    .filter((w) => w.source === 'tocfl' && w.level === 'N1' && w.pinyinNumeric)
    .slice(0, 12)
    .map((w) => w.id);
  await page.route('**/audio/manifest.json', async (route) => {
    const words = Object.fromEntries(
      ids.map((id) => [id, { file: `words/${id}.mp3`, voice: 'v', hash: `h-${id}`, status: 'auto_ok', text: id, zhuyin: '' }]),
    );
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ meta: { version: 1, builtAt: '2026-01-01T00:00:00Z', voice: 'v' }, words, sentences: {} }),
    });
  });
  await page.route('**/audio/words/*.mp3', (route) =>
    route.fulfill({ contentType: 'audio/mpeg', body: Buffer.from([0xff, 0xfb, 0x90, 0x00]) }),
  );
});

async function seed(page: import('@playwright/test').Page) {
  await page.goto('/?page=review');
  await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
  await page.evaluate(async (wordIds) => {
    const now = new Date();
    const past = new Date(now.getTime() - 86_400_000);
    const card = {
      due: past, stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1,
      learning_steps: 0, reps: 1, lapses: 0, state: 2, last_review: past,
    };
    const row = (id: string, skill: string) => ({
      pk: `word:${id}:${skill}`, item: { kind: 'word', id }, skill, card,
      state: 'review', lapses: 0, leech: false, leechTreatmentsTried: [],
      familiarity: 0, readingDependence: 0, flags: {}, updatedAt: now,
    });
    const w = window as unknown as { __anan: { db: { items: { bulkPut: (r: unknown[]) => Promise<unknown> } } } };
    await w.__anan.db.items.bulkPut(wordIds.flatMap((id) => [row(id, 'recognition'), row(id, 'listening')]));
  }, ids);
}

test('a Listen session prefetches its clips and keeps working offline', async ({ page, context }) => {
  await page.addInitScript(() => localStorage.removeItem('anan.listening.disabled'));
  const clipRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/audio/words/')) clipRequests.push(r.url());
  });
  await seed(page);
  await page.reload();
  await page.getByTestId('listen-session-btn').click();
  await expect(page.getByTestId('listen-exercise').first()).toBeVisible();
  await expect.poll(() => clipRequests.length).toBeGreaterThan(0);
  await context.setOffline(true);
  await page.getByTestId('listen-sounds-wrong').click(); // moves on using only local data
  await expect(page.getByTestId('listen-page')).toBeVisible();
  await context.setOffline(false);
});

test('Listen session never autoplays, and "Sounds wrong" skips with no penalty', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('anan.listening.disabled');
    (window as unknown as { __plays: number }).__plays = 0;
    HTMLMediaElement.prototype.play = function () {
      (window as unknown as { __plays: number }).__plays++;
      return Promise.resolve();
    };
  });
  await seed(page);
  await page.reload();
  await page.getByTestId('listen-session-btn').click();
  await expect(page.getByTestId('listen-exercise').first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __plays: number }).__plays)).toBe(0);

  await page.getByTestId('listen-play').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __plays: number }).__plays))
    .toBe(1);

  const before = await page.getByTestId('listen-exercise').first().getAttribute('data-type');
  await page.getByTestId('listen-sounds-wrong').click();
  // skipped: the next exercise (or the summary) is shown, with no feedback panel
  await expect(page.getByTestId('listen-feedback')).toHaveCount(0);
  expect(before).toBeTruthy();
});
