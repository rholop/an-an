import { expect, test } from './fixtures.js';
import { seedKnownWords } from './seed-known-words.js';

/**
 * Phase 33: every free Gemini model is out of quota. The proxy answers 503 quota_exhausted with
 * resetsAt; the app says so in plain words, and lessons and review still work.
 */
const AI_ROUTES = /\/v1\/(story|story-check|story-repair|turn|journal-[a-z-]+|topic-words)$/;

test.describe('Free AI quota used up (phase 33)', () => {
  test('a story says when the quota is back; a lesson and review still work; Settings shows AI usage', async ({ page }) => {
    test.setTimeout(90_000);
    const resetsAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
    let aiCalls = 0;
    await page.route(
      (url) => AI_ROUTES.test(url.pathname),
      async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        aiCalls++;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ error: 'quota_exhausted', resetsAt }),
        });
      },
    );

    await seedKnownWords(page);
    await page.addInitScript(() => localStorage.removeItem('anan.study.disabled'));
    await page.goto('/?page=textbook');
    await expect(page.getByRole('heading', { name: /來學華語/ }).first()).toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      await page.getByTestId('my-class-toggle').check({ timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    await page.getByTestId('my-class-lesson').selectOption('3');
    await expect(page.getByTestId('class-status')).toBeVisible();

    // A story: the plain message, never a raw error
    await page.goto('/?page=reader');
    await expect(page.getByTestId('stories-section')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('next-story').click();
    await expect(page.getByTestId('stories-section')).toContainText(
      /The free AI quota is used up until about \d{1,2}(:\d\d)? (am|pm)\. Lessons, review and everything else still work\./,
      { timeout: 20_000 },
    );
    expect(aiCalls).toBeGreaterThan(0);
    await expect(page.getByTestId('stories-section')).not.toContainText('quota_exhausted');

    // A lesson: the vocabulary step reviews cards as usual
    await page.goto('/?page=textbook');
    await page.getByTestId('lesson-3').getByRole('button').first().click();
    await page.getByTestId('study-lesson').click();
    await expect(page.getByTestId('study-session')).toContainText('Step 1 of 5');
    await page.getByRole('button', { name: 'Show answer' }).first().click();
    await page.getByRole('button', { name: 'Good' }).click();

    // Review: a due card is shown, revealed and rated
    await page.goto('/?page=review');
    await page.waitForFunction(() => Boolean((window as unknown as { __anan?: unknown }).__anan));
    await page.evaluate(async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 86_400_000);
      await (window as unknown as { __anan: { db: { items: { bulkPut: (rows: unknown[]) => Promise<unknown> } } } }).__anan.db.items.bulkPut([
        {
          pk: 'word:tocfl-53d2a1b065:recognition',
          item: { kind: 'word', id: 'tocfl-53d2a1b065' },
          skill: 'recognition',
          card: { due: past, stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 2, last_review: past },
          state: 'review',
          lapses: 0,
          leech: false,
          leechTreatmentsTried: [],
          familiarity: 0,
          readingDependence: 0,
          flags: {},
          updatedAt: now,
        },
      ]);
    });
    await page.reload();
    await page.getByRole('button', { name: 'Show answer' }).first().click({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Good' }).click();

    // Settings → AI usage: the server's count per model
    await page.goto('/?page=review-settings');
    const usage = page.getByTestId('settings-ai-usage');
    await expect(usage).toContainText('AI usage', { timeout: 20_000 });
    await expect(usage.getByTestId('ai-usage-model').first()).toBeVisible();
    await expect(usage.getByTestId('ai-usage-stories')).toHaveText(/^\d+$/);
  });
});
