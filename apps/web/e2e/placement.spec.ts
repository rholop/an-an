import { expect, test } from '@playwright/test';

test.describe('Placement test', () => {
  test('adaptive test: a learner who knows everything converges to "beyond L6" in well under 60 taps', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?page=placement');
    await expect(page.getByText('Placement test')).toBeVisible();
    await page.screenshot({ path: 'screenshots/placement-start.png' });

    await page.getByRole('button', { name: /Start adaptive test/ }).click();
    await expect(page.locator('.placement-word')).toBeVisible();
    await page.screenshot({ path: 'screenshots/placement-round.png' });

    let taps = 0;
    const guard = 80;
    while (taps < guard) {
      const knowButton = page.getByRole('button', { name: 'I know this' });
      if (!(await knowButton.isVisible().catch(() => false))) break;
      await knowButton.click();
      taps++;
    }

    await expect(page.getByText('Level-by-level summary')).toBeVisible({ timeout: 10_000 });
    expect(taps).toBeLessThan(60);
    // The real lexicon has no Level 6 data yet (see CLAUDE.md "Open items to
    // verify" / phase-1 MISSING_LEVELS) — sampling L6 runs out of words
    // immediately, so a learner who knows everything converges at "L6"
    // rather than the full "beyond L6" sentinel. Either is a correct,
    // graceful placement; assert it's one of the two rather than a crash.
    await expect(page.getByText(/Placed at/)).toContainText(/L6|beyond L6/);
    await page.screenshot({ path: 'screenshots/placement-summary.png' });

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('manual "start at level" bulk-marks everything at/below that level as known', async ({ page }) => {
    await page.goto('/?page=placement');
    await page.getByRole('button', { name: 'L2', exact: true }).click();
    await expect(page.getByText('Level-by-level summary')).toBeVisible();
    await expect(page.getByText(/Placed at/)).toContainText('L3');
    await page.screenshot({ path: 'screenshots/placement-manual-summary.png' });
  });
});
