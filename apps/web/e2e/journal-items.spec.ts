import { expect, test } from './fixtures.js';

interface Anan {
  db: { errorItems: { bulkPut: (rows: unknown[]) => Promise<unknown> } };
}
declare global {
  interface Window {
    __anan: Anan;
  }
}

const card = () => ({
  due: new Date(Date.now() - 60_000),
  stability: 0,
  difficulty: 0,
  elapsed_days: 0,
  scheduled_days: 0,
  learning_steps: 0,
  reps: 0,
  lapses: 0,
  state: 0,
});

// Phase 17 Part D: what a journal review card shows, whatever kind of fix it asks for.
test('a journal card says what kind of fix it is and always shows what you wrote and the correct sentence', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__anan));
  await page.evaluate((mk) => {
    const base = {
      journalEntryId: 'e2e',
      type: 'error',
      flagged: false,
      createdAt: new Date(),
      status: 'active',
      version: 2,
      en: 'My surname is Yin.',
      explanationEn: 'Say 我姓印 (no 的).',
      original: '我的姓印。',
      corrected: '我姓印。',
    };
    return window.__anan.db.errorItems.bulkPut([
      {
        ...base,
        id: 'v2:e2e:0:e0',
        span: [1, 2],
        card: new Function(`return (${mk})()`)(),
        marks: { original: [[1, 2]], corrected: [[1, 1]] },
        exercise: {
          kind: 'extra_word',
          prompt: "One word here doesn't belong. Tap it.",
          tokens: ['我', '的', '姓', '印', '。'],
          extraTokenIndex: 1,
          accepted: [],
        },
      },
    ]);
  }, card.toString());

  await page.goto('/?page=cloze');
  await page.getByRole('button', { name: /Start session/ }).click({ timeout: 20000 });
  await expect(page.getByText("One word here doesn't belong. Tap it.")).toBeVisible();
  await expect(page.getByText('My surname is Yin.')).toBeVisible();

  await page.getByRole('button', { name: '姓' }).click(); // wrong word
  await expect(page.getByText('Not quite.')).toBeVisible();
  await expect(page.getByText('You wrote:')).toBeVisible();
  await expect(page.getByText('Correct:')).toBeVisible();
  await expect(page.getByText('Say 我姓印 (no 的).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'I think mine is right too' })).toBeVisible();
});
