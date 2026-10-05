import { expect, test } from './fixtures.js';

interface Anan {
  db: {
    errorItems: {
      put: (row: unknown) => Promise<unknown>;
      get: (id: string) => Promise<{ status: string; report?: { reason: string } } | undefined>;
    };
  };
}
declare global {
  interface Window {
    __anan: Anan;
  }
}

// Phase 16 Part C: the "Something's wrong" button and sheet, by tap, at phone size.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('reporting a journal cloze removes it at once, and Undo brings it back', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__anan));
  const due = new Date(Date.now() - 60_000);
  await page.evaluate((dueIso) => {
    return window.__anan.db.errorItems.put({
      id: 'e2e:0',
      journalEntryId: 'e2e',
      original: '我昨天去了台灣。',
      corrected: '我今天去了台灣。',
      span: [1, 3],
      blank: [1, 3],
      type: 'error',
      card: {
        due: new Date(dueIso),
        stability: 0,
        difficulty: 0,
        elapsed_days: 0,
        scheduled_days: 0,
        learning_steps: 0,
        reps: 0,
        lapses: 0,
        state: 0,
      },
      flagged: false,
      createdAt: new Date(),
      status: 'active',
      version: 2,
      en: 'I went to Taiwan today.',
      explanationEn: 'Today, not yesterday.',
      marks: { original: [[1, 3]], corrected: [[1, 3]] },
      exercise: {
        kind: 'cloze',
        prompt: 'Use the right word here.',
        blankStart: 1,
        blankEnd: 3,
        answer: '今天',
        accepted: ['今天'],
      },
    });
  }, due.toISOString());

  await page.goto('/?page=cloze');
  await page.getByRole('button', { name: /Start session/ }).click({ timeout: 15000 });
  await expect(page.getByText('From your journal')).toBeVisible();

  const flag = page.getByRole('button', { name: /Something's wrong/ });
  const box = await flag.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await flag.tap();
  await page.getByRole('button', { name: /garbled/ }).tap();

  await expect(page.getByText("Thanks, this one won't come back.")).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.__anan.db.errorItems.get('e2e:0')))?.status)
    .toBe('reported');
  expect(
    (await page.evaluate(() => window.__anan.db.errorItems.get('e2e:0')))?.report?.reason,
  ).toBe('garbled');
  await expect(page.getByText('Session complete')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).tap();
  await expect
    .poll(async () => (await page.evaluate(() => window.__anan.db.errorItems.get('e2e:0')))?.status)
    .toBe('active');
});
