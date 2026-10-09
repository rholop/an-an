import { expect, test } from '@playwright/test';
import { collectFindings, openApp, prepareContext, type Theme } from './support.js';

/** Phase 24: a story works by tap on a phone; screenshots in both themes. */
for (const theme of ['light', 'dark'] as Theme[]) {
  test(`a graded story by tap on a phone (${theme})`, async ({ page }) => {
    test.setTimeout(90_000);
    await prepareContext(page, 'signed-in', theme);
    await page.context().addInitScript(() => localStorage.setItem('anan.stories.fake', '1'));
    await openApp(page, 'garden');
    await page.evaluate(async () => {
      const data = (await (await fetch('/lexicon/lexicon.v2.json')).json()) as {
        words: { id: string; level: string | null; tags: string[] }[];
      };
      const now = new Date();
      const events = data.words
        .filter((w) => w.level === 'N1' && !w.tags.includes('name'))
        .slice(0, 150)
        .map((w) => ({ item: { kind: 'word', id: w.id }, skill: 'recognition', kind: 'anki_import_seen', at: now }));
      await (window as unknown as { __anan: { learnerService: { recordBulk: (e: unknown[], n: Date) => Promise<unknown> } } }).__anan.learnerService.recordBulk(events, now);
    });

    await openApp(page, 'reader');
    await expect(page.getByTestId('stories-section')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `screenshots/stories-section-${theme}-phone.png` });
    await page.getByTestId('next-story').tap();
    const view = page.getByTestId('story-view');
    await expect(view).toBeVisible({ timeout: 20_000 });
    // Phase 26: a story with words outside the known list teaches them first ("Words in this story")
    const start = page.getByTestId('story-start-reading');
    if (await start.isVisible()) {
      await page.screenshot({ path: `screenshots/story-words-${theme}-phone.png`, fullPage: true });
      expect((await collectFindings(page)).map((f) => `${f.kind}: ${f.where} (${f.detail})`)).toEqual([]);
      await start.tap();
    }
    await page.waitForTimeout(300);
    expect((await collectFindings(page)).map((f) => `${f.kind}: ${f.where} (${f.detail})`)).toEqual([]);
    await page.screenshot({ path: `screenshots/story-${theme}-phone.png`, fullPage: true });

    await view.locator('.story-paragraph .an-token').first().tap();
    await expect(page.locator('.an-popover, .an-sheet').first()).toBeVisible();
    await page.screenshot({ path: `screenshots/story-lookup-${theme}-phone.png` });
    await page.getByTestId('story-title').tap();

    await page.getByTestId('story-done-reading').tap();
    const questions = page.getByTestId('story-question');
    const n = await questions.count();
    for (let i = 0; i < n; i++) await questions.nth(i).locator('[data-right="1"]').tap();
    await page.getByTestId('story-check').tap();
    await page.screenshot({ path: `screenshots/story-questions-${theme}-phone.png`, fullPage: true });
    await page.getByTestId('story-finish').tap();
    await expect(page.getByTestId('story-summary-line')).toContainText('words you know');
    await page.waitForTimeout(300);
    expect((await collectFindings(page)).map((f) => `${f.kind}: ${f.where} (${f.detail})`)).toEqual([]);
    await page.screenshot({ path: `screenshots/story-summary-${theme}-phone.png`, fullPage: true });
  });
}
