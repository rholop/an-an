import { expect, test } from '@playwright/test';

const SAMPLE_DECK = [
  '#separator:tab',
  '#html:false',
  '貓\tmāo\tcat',
  '咖啡\tkāfēi\tcoffee',
  '長\tcháng\tlong',
  '不存在詞語甲\tbuxcunzai\tnot a real word',
  '不存在詞語乙\tbuxcunzai2\tanother fake word',
].join('\n');

test.describe('Anki import', () => {
  test('parses a plain-text export, matches against the real lexicon, and reports matched/ambiguous/unmatched', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?page=anki-import');
    await expect(page.getByText('Anki import')).toBeVisible();

    await page.locator('input[type=file]').setInputFiles({
      name: 'deck.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(SAMPLE_DECK, 'utf-8'),
    });

    await expect(page.getByText('5 rows parsed.')).toBeVisible();
    await page.screenshot({ path: 'screenshots/anki-import-columns.png' });

    // Pick column 1 as the headword column.
    await page.locator('.anki-column-picker').first().locator('select').selectOption('0');

    await expect(page.getByText('Total: 5')).toBeVisible();
    await expect(page.locator('.anki-summary-matched')).toHaveText('Matched: 2');
    await expect(page.locator('.anki-summary-ambiguous')).toHaveText('Ambiguous: 1');
    await expect(page.locator('.anki-summary-unmatched')).toHaveText('Unmatched: 2');
    await page.screenshot({ path: 'screenshots/anki-import-summary.png' });

    await page.getByRole('button', { name: /Import 3 matched\/ambiguous/ }).click();
    await expect(page.getByText(/Imported 3 matched\/ambiguous words/)).toBeVisible();

    await page.getByRole('button', { name: /Add 2 unmatched as custom words/ }).click();
    await expect(page.getByText(/Added 2 unmatched words as custom entries/)).toBeVisible();
    await page.screenshot({ path: 'screenshots/anki-import-done.png' });

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('custom words from an Anki import show up in the reader afterwards', async ({ page }) => {
    await page.goto('/?page=anki-import');
    await page.locator('input[type=file]').setInputFiles({
      name: 'deck.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('獨特詞彙測試\txīnmì\ta custom test word\n', 'utf-8'),
    });
    await page.locator('.anki-column-picker').first().locator('select').selectOption('0');
    await page.locator('.anki-column-picker').nth(1).locator('select').selectOption('1');
    await page.locator('.anki-column-picker').nth(2).locator('select').selectOption('2');
    await page.getByRole('button', { name: /Add 1 unmatched as custom words/ }).click();
    await expect(page.getByText(/Added 1 unmatched words as custom entries/)).toBeVisible();

    await page.getByRole('button', { name: 'Reader' }).click();
    await page.fill('textarea', '獨特詞彙測試');
    await expect(page.locator('.an-token').first()).toBeVisible();
    await page.locator('.an-token').first().click();
    await expect(page.getByText('a custom test word')).toBeVisible();
    await page.screenshot({ path: 'screenshots/anki-import-custom-in-reader.png' });
  });
});
