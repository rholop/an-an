import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

type Handle = {
  learnerService: { recordBulk: (events: unknown[], now: Date) => Promise<unknown> };
  db: {
    evidence: { toArray: () => Promise<{ kind: string; context?: { source?: string } }[]> };
    stories: { toArray: () => Promise<{ id: string; readAt?: unknown; score?: { right: number; of: number } }[]> };
    items: { toArray: () => Promise<{ item: { id: string }; state: string }[]> };
  };
};
const handle = (page: Page) => page.evaluate(() => Boolean((window as unknown as { __anan?: Handle }).__anan));

/** 150 N1 words as Anki-seen: the learner's rung 1, so a story can be made of them. */
export async function seedKnownWords(page: Page) {
  await page.goto('/?page=garden');
  await expect.poll(() => handle(page), { timeout: 20_000 }).toBe(true);
  await page.evaluate(async () => {
    const data = (await (await fetch('/lexicon/lexicon.v2.json')).json()) as {
      words: { id: string; level: string | null; tags: string[] }[];
    };
    const now = new Date();
    const events = data.words
      .filter((w) => w.level === 'N1' && !w.tags.includes('name'))
      .slice(0, 150)
      .map((w) => ({ item: { kind: 'word', id: w.id }, skill: 'recognition', kind: 'anki_import_seen', at: now }));
    await (window as unknown as { __anan: Handle }).__anan.learnerService.recordBulk(events, now);
  });
}

test.describe('Graded stories (phase 24)', () => {
  test('Stories in the Reader: Next story, tap a word, English, questions, summary, Add to review, library, Progress, Home', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await seedKnownWords(page);

    await page.goto('/?page=reader');
    const section = page.getByTestId('stories-section');
    await expect(section).toBeVisible({ timeout: 20_000 });
    // the section is at the top of the Reader
    const sectionBox = (await section.boundingBox())!;
    const readerTitle = (await page.getByText("An'an reader").boundingBox())!;
    expect(sectionBox.y).toBeLessThan(readerTitle.y);

    // Easier / Just right / Harder is remembered per profile
    await page.getByTestId('story-difficulty-harder').click();
    await page.reload();
    await expect(page.getByTestId('story-difficulty-harder')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
    await page.getByTestId('story-difficulty-middle').click();

    await page.getByLabel('Use fake story writer (dev)').check();
    await page.getByTestId('next-story').click();
    const view = page.getByTestId('story-view');
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('story-title')).not.toBeEmpty();

    // the level word is underlined lightly, with no hover gloss
    const fresh = view.locator('.an-token--new').first();
    await expect(fresh).toBeVisible();
    await expect(fresh).not.toHaveAttribute('title', /.+/);
    // a tap is a lookup (source: story)
    await view.locator('.story-paragraph .an-token').first().click();
    await expect(page.locator('.an-popover')).toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate(() => (window as unknown as { __anan: Handle }).__anan.db.evidence.toArray())).some(
          (e) => e.kind === 'chat_lookup_gloss' && e.context?.source === 'story',
        ),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await page.getByTestId('story-title').click();

    // per-paragraph English
    await page.getByTestId('story-english-toggle').first().click();
    await expect(page.getByTestId('story-english').first()).toBeVisible();

    // questions: pick the right options, check, finish
    await page.getByTestId('story-done-reading').click();
    const questions = page.getByTestId('story-question');
    const n = await questions.count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(4);
    for (let i = 0; i < n; i++) {
      const right = questions.nth(i).locator('[data-testid="story-option"][data-right="1"]');
      await expect(right).toHaveCount(1); // exactly one right option
      await right.click();
    }
    await page.getByLabel('Show English').check();
    await expect(page.locator('.story-q-en').first()).toBeVisible();
    await page.getByTestId('story-check').click();
    await page.getByTestId('story-finish').click();

    const summary = page.getByTestId('story-summary');
    await expect(summary).toBeVisible();
    await expect(page.getByTestId('story-summary-line')).toHaveText(/You read \d+ characters · \d+% words you know/);
    await expect(summary).toContainText(`${n} of ${n} right`);
    await expect(page.getByTestId('story-tapped')).toBeVisible();
    await expect(page.getByTestId('story-new-words')).toBeVisible();
    await page.getByTestId('story-add-review').click();
    await expect(page.getByTestId('story-add-review')).toHaveText(/Added to review/);

    // evidence: no word evidence for answers; due/learning words read without a lookup
    const kinds = await page.evaluate(() =>
      (window as unknown as { __anan: Handle }).__anan.db.evidence.toArray().then((ev) => ev.map((e) => e.kind)),
    );
    expect(kinds).toContain('story_read_no_lookup');
    const stories = await page.evaluate(() => (window as unknown as { __anan: Handle }).__anan.db.stories.toArray());
    const read = stories.filter((s) => s.readAt);
    expect(read).toHaveLength(1);
    expect(read[0]!.score).toEqual({ right: n, of: n });

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('story-library')).toBeVisible();
    await expect(page.locator('[data-testid="story-item"][data-read="1"]')).toHaveCount(1);

    // another was written in the background for this lesson (2 kept ready): Home offers it
    await expect
      .poll(async () => (await page.evaluate(() => (window as unknown as { __anan: Handle }).__anan.db.stories.toArray())).length, {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);
    await page.goto('/?page=garden');
    const line = page.getByTestId('home-story');
    await expect(line).toContainText(/Today's story: A \d+-minute story/, { timeout: 20_000 });
    await line.getByRole('button').click();
    await expect(page.getByTestId('story-view')).toBeVisible();
    await page.getByRole('button', { name: '← Back to home' }).click();

    await page.goto('/?page=progress');
    await expect(page.getByTestId('progress-stories')).toHaveText(/Characters read this week: \d+ · 1 story finished/, {
      timeout: 20_000,
    });
    expect(errors).toEqual([]);
  });
});
