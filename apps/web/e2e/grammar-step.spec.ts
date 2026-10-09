import { expect, test } from './fixtures.js';

/** Phase 25 Part B: the lesson grammar step on 來學華語 1 lesson 4 (A-not-A, 呢, 的). */
test('b1 L4 grammar: 9 exercises round-robin, a miss comes back on another sentence, Undo clears it, dots move', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?page=textbook');
  await page.getByTestId('my-class-toggle').check();
  await page.getByTestId('my-class-lesson').selectOption('4');
  await expect(page.getByTestId('class-status')).toBeVisible();
  await page.getByTestId('lesson-4').getByRole('button').first().click();
  await expect(page.getByTestId('lesson-grammar-counter')).toHaveText('Grammar: 0 practised · 0 mastered');
  await expect(page.locator('.textbook-grammar [data-testid="grammar-dots"]')).toHaveCount(3);
  await page.getByTestId('study-lesson').click();
  await page.getByTestId('study-skip').click(); // vocabulary

  const ex = page.getByTestId('grammar-exercise');
  await expect(ex).toBeVisible();
  await expect(page.getByTestId('grammar-position')).toHaveText('1 of 9');

  const shown: Array<{ grammar: string; sentence: string; right: boolean }> = [];
  let undone = false;
  for (let i = 0; i < 30 && (await ex.isVisible()); i++) {
    const grammar = (await ex.getAttribute('data-grammar'))!;
    const sentence = (await ex.getAttribute('data-sentence'))!;
    const type = await ex.getAttribute('data-type');
    if (type === 'fill') {
      // The right answer is the point's signal word (呢 / 的), which its pattern names.
      const header = await ex.locator('p').first().innerText();
      const opts = ex.getByTestId('grammar-option');
      const texts = await opts.allInnerTexts();
      const right = texts.findIndex((t) => header.includes(t));
      await opts.nth(right >= 0 ? right : 0).click();
    } else if (type === 'pick') {
      await ex.getByTestId('grammar-option').first().click();
    } else {
      // Tiles in the order shown: never the right order (the builder never deals it in order).
      const check = ex.getByTestId('grammar-check');
      while (await check.isDisabled()) await ex.locator('[data-testid="grammar-tile"]:not([disabled])').first().click();
      await check.click();
    }
    const right = (await ex.getByRole('status').innerText()).startsWith('✓ Correct');
    shown.push({ grammar, sentence, right });
    if (!right && shown.length <= 9) {
      await expect(page.getByTestId('grammar-position')).toContainText('+');
      if (!undone) {
        // Undo takes the answer and its extra away; the same exercise is asked again.
        undone = true;
        const before = await page.getByTestId('grammar-position').innerText();
        await page.getByTestId('grammar-undo').click();
        await expect(page.getByTestId('grammar-position')).not.toHaveText(before);
        await expect(page.getByTestId('grammar-position')).not.toContainText('extra');
        shown.pop();
        i--;
        continue;
      }
    }
    await page.getByTestId('grammar-next').click();
  }
  await expect(page.getByTestId('grammar-step-done')).toBeVisible();

  // 9 planned exercises: A B C A B C A B C, every sentence different.
  const base = shown.slice(0, 9);
  expect(base.map((s) => s.grammar)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2].map((k) => base[k]!.grammar));
  expect(new Set(base.map((s) => s.grammar)).size).toBe(3);
  expect(new Set(base.map((s) => s.sentence)).size).toBe(9);
  // Every miss came back once, on the same point but another sentence.
  const misses = base.filter((s) => !s.right);
  const extras = shown.slice(9);
  expect(misses.length).toBeGreaterThan(0);
  expect(extras).toHaveLength(misses.length);
  for (const [k, m] of misses.entries()) {
    expect(extras[k]!.grammar).toBe(m.grammar);
    expect(extras[k]!.sentence).not.toBe(m.sentence);
  }

  // The dots moved: every point answered right at least once shows it; nothing is mastered on day one.
  const rightPoints = new Set(shown.filter((s) => s.right).map((s) => s.grammar));
  expect(rightPoints.size).toBeGreaterThan(0);
  const outcomes = page.getByTestId('grammar-outcome');
  await expect(outcomes).toHaveCount(3);
  await expect(page.getByTestId('grammar-step-done').locator('[data-dots="0"]')).toHaveCount(3 - rightPoints.size);
  await expect(page.getByTestId('grammar-step-done')).not.toContainText('mastered.');
  await page.screenshot({ path: 'screenshots/grammar-step-done.png' });
  await page.getByTestId('grammar-done').click();
});
