import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: {
        errorItems: { toArray: () => Promise<{ pattern?: string; flagged: boolean }[]> };
        journalReviews: { toArray: () => Promise<{ issues: unknown[]; flagged: number[] }[]> };
      };
    };
  }
}

test.describe('Journal page', () => {
  test('write -> self-correct -> reveal -> flag -> finish feeds the error bank', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?page=journal');
    await page.waitForFunction(() => Boolean(window.__anan));
    await page.getByLabel(/Use fake tutor/).check();

    await expect(page.getByText(/not always — if something looks wrong/)).toBeVisible();
    await page.getByLabel('Journal entry').fill('今天我搭地鐵。我去 [gym]。');
    await page.getByRole('button', { name: 'Submit for feedback' }).click();

    // Self-correction comes first: the span is highlighted but the answer is not shown.
    await expect(page.getByRole('heading', { name: 'Spot the mistakes' })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('.journal-text mark.journal-hl--mainland_style')).toHaveText('地鐵');
    await expect(page.getByText('捷運', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/\[gym\] →/)).toBeVisible();

    // Self-fix, then check.
    await page.getByLabel('Your fix for part 1').fill('捷運');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText(/Looks good/)).toBeVisible();

    await page.getByRole('button', { name: 'Show corrections' }).click();
    await expect(page.getByText('You fixed this yourself')).toBeVisible();
    await expect(page.getByText('In Taiwan the metro is usually called 捷運.')).toBeVisible();

    await page.getByRole('button', { name: 'Explain more' }).click();
    await expect(page.getByText(/More detail/)).toBeVisible();

    await page.getByRole('button', { name: 'Finish entry' }).click();
    await expect(page.getByText(/Entry saved/)).toBeVisible();

    const bank = await page.evaluate(() => window.__anan.db.errorItems.toArray());
    expect(bank.map((b) => b.pattern)).toEqual(['mainland-vocab']);
    await expect(page.getByRole('img', { name: /Errors per 100 characters/ })).toBeVisible();

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('a flagged correction never reaches the error bank', async ({ page }) => {
    await page.goto('/?page=journal');
    await page.waitForFunction(() => Boolean(window.__anan));
    await page.getByLabel(/Use fake tutor/).check();
    await page.getByLabel('Journal entry').fill('我搭地鐵。');
    await page.getByRole('button', { name: 'Submit for feedback' }).click();
    await page.getByRole('button', { name: 'Show corrections' }).click();
    await page.getByRole('button', { name: 'Flag this correction' }).click();
    await page.getByRole('button', { name: 'Finish entry' }).click();
    await expect(page.getByText(/Entry saved/)).toBeVisible();

    expect(await page.evaluate(() => window.__anan.db.errorItems.toArray())).toEqual([]);
    await expect(page.getByTestId('flag-metric')).toContainText('1 of 1');
  });
});
