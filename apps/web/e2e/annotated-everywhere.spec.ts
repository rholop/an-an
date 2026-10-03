import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
      db: { evidence: { toArray: () => Promise<{ kind: string }[]> } };
    };
  }
}

const IDS = {
  塊: 'tocfl-64e19ba0ac', // measure word, "dollar"
  兩: 'tocfl-a844cb0bd2', // numeral, "two"
  咖啡: 'tocfl-7c491838af',
  吃: 'tocfl-29992340ae',
};

/** One review a year ago, so every word is long overdue (due now, and wilting in the garden). */
async function seedOverdue(page: Page, ids: string[]) {
  await page.waitForFunction(() => Boolean(window.__anan));
  await page.evaluate(async (list) => {
    const long = new Date(Date.now() - 365 * 86_400_000);
    for (const id of list) {
      for (let i = 0; i < 2; i++) {
        await window.__anan.learnerService.record(
          { item: { kind: 'word', id }, skill: 'production', kind: 'review_good', at: long },
          new Date(long.getTime() + i * 86_400_000),
        );
      }
    }
  }, ids);
}

test.describe('annotated text outside the reader', () => {
  test('garden tiles always show the reading, a hover definition, and a clickable popover that is not covered', async ({
    page,
  }) => {
    await page.goto('/?page=garden');
    await expect(page.getByRole('heading', { name: 'Word garden' })).toBeVisible({ timeout: 15000 });
    await seedOverdue(page, [IDS.咖啡, IDS.吃]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Word garden' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'All', exact: true }).click();

    const tiles = page.locator('.garden-tile');
    await expect(tiles.first()).toBeVisible();
    // the reading is on screen for every tile — never hidden behind hover
    const count = await tiles.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      const rt = tiles.nth(i).locator('rt').first();
      await expect(rt).toBeVisible();
      await expect(rt).not.toHaveText('');
    }
    // tile accessibility label is still there (game.spec relies on it) and no longer hides the word
    await expect(tiles.first()).toHaveAttribute('role', 'group');

    // hover definition: a tooltip with the gloss on every word
    const eat = page.locator('.garden-tile .an-token', { hasText: '吃' }).first();
    await expect(eat).toHaveAttribute('title', /to eat/);

    // click opens the full popover, and nothing paints over it (even on a faded tile)
    await eat.click();
    const popover = page.locator('.an-popover');
    await expect(popover).toBeVisible();
    const box = (await popover.boundingBox())!;
    const topmost = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.an-popover') !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(topmost).toBe(true);
    await expect(popover).toContainText('to eat');
  });

  test('journal prompts are annotated, and numerals/measure words are never suggested', async ({
    page,
  }) => {
    await page.goto('/?page=journal');
    await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible({ timeout: 15000 });
    await seedOverdue(page, [IDS.塊, IDS.兩, IDS.咖啡, IDS.吃]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible({ timeout: 15000 });

    const words = page.locator('.journal-prompt-words');
    await expect(words).toBeVisible();
    // 咖啡 and 吃 are offered; 塊 ("dollar") and 兩 ("two") are skipped even though they are due
    await expect(words).toContainText('咖');
    await expect(words).toContainText('吃');
    await expect(words).not.toContainText('塊');
    await expect(words).not.toContainText('兩');

    // every suggested word shows its reading and has a hover definition + popover
    const tokens = words.locator('.an-token');
    expect(await tokens.count()).toBe(2);
    for (let i = 0; i < 2; i++) {
      await expect(tokens.nth(i).locator('rt').first()).toBeVisible();
      await expect(tokens.nth(i)).toHaveAttribute('title', /.+/);
    }
    await tokens.first().click();
    await expect(page.locator('.an-popover')).toBeVisible();
  });

  test('a journal prompt with a Chinese starter shows pinyin over it', async ({ page }) => {
    await page.goto('/?page=journal');
    await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible({ timeout: 15000 });
    const starter = page.locator('.journal-prompt .an-token').first();
    // today's prompt may be the free-write one (no starter); only assert when there is one
    if (await starter.count()) {
      await expect(starter.locator('rt').first()).toBeVisible();
      await expect(starter).toHaveAttribute('title', /.+/);
    }
  });

  test('hovering annotated text still never counts as a lookup', async ({ page }) => {
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.__anan));
    await page.locator('.an-token').nth(1).hover();
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() => window.__anan.db.evidence.toArray());
    expect(rows).toHaveLength(0);
  });
});
