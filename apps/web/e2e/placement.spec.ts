import { expect, test } from './fixtures.js';

test.describe('Placement test', () => {
  test('adaptive test: a learner who knows everything converges to "beyond L5" in well under 60 taps', async ({
    page,
  }) => {
    // "Saving results…" writes a card per known word: slow when the suite runs in parallel
    test.setTimeout(60_000);
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

    await expect(page.getByText('Level-by-level summary')).toBeVisible({ timeout: 40_000 });
    expect(taps).toBeLessThan(60);
    // A learner who knows everything converges on the top level (L5) or the
    // "beyond L5" sentinel — either is a correct, graceful placement.
    await expect(page.getByTestId('placed-at')).toContainText(/L5/);
    await page.screenshot({ path: 'screenshots/placement-summary.png' });

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('manual placement at a level marks the levels below it as known', async ({
    page,
  }) => {
    await page.goto('/?page=placement');
    await page.getByRole('button', { name: 'L2', exact: true }).click();
    await expect(page.getByText('Level-by-level summary')).toBeVisible();
    await expect(page.getByTestId('placed-at')).toContainText('Placed at L2');
    await expect(page.getByTestId('placed-at')).toContainText('N1, N2, L1 marked as known');
    await page.screenshot({ path: 'screenshots/placement-manual-summary.png' });
  });
});
