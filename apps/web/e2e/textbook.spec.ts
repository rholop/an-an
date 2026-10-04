import { expect, test } from './fixtures.js';

test.describe('Textbook / My class (phase 12)', () => {
  test('My class: turn on, set lesson 4, see the path, lesson detail with words, grammar and the private dialogue', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/?page=textbook');
    await expect(page.getByRole('heading', { name: /來學華語/ }).first()).toBeVisible();
    await expect(page.getByTestId('class-status')).toHaveCount(0); // off by default

    await page.getByTestId('my-class-toggle').check();
    await page.getByTestId('my-class-lesson').selectOption('4');
    await expect(page.getByTestId('class-status')).toHaveText("We're on lesson 4 in class.");
    await expect(page.getByRole('status').filter({ hasText: /Added \d+ words and grammar points/ })).toBeVisible();
    await expect(page.getByTestId('lesson-4')).toHaveClass(/textbook-lesson--now/);
    await expect(page.getByTestId('lesson-5')).toHaveClass(/textbook-lesson--next/);
    await expect(page.getByTestId('lesson-8')).toHaveClass(/textbook-lesson--later/);
    await page.screenshot({ path: 'screenshots/textbook-path.png' });

    await page.getByTestId('lesson-4').getByRole('button').first().click();
    await expect(page.getByRole('heading', { name: /我爸爸在電腦公司工作/ })).toBeVisible();
    await expect(page.getByText('Grammar (3)')).toBeVisible();
    // The book's own dialogue arrives through the proxy, with the household code.
    // The book's own dialogue is private (not in git): CI and fresh checkouts don't have it.
    const dialogue = page.getByTestId('dialogue');
    const missing = page.getByTestId('dialogue-unavailable');
    await expect(dialogue.or(missing)).toBeVisible();
    if (await dialogue.isVisible()) await expect(dialogue).toContainText('王明文');
    await page.screenshot({ path: 'screenshots/textbook-lesson.png', fullPage: true });

    // A word's popover carries the badge and the book's own gloss.
    await page.locator('.textbook-words .an-token').first().click();
    await expect(page.getByTestId('textbook-badge').first()).toContainText('來學華語 1 · L4');
    // A 404 for the private dialogue is expected where the book text isn't installed (CI).
    const real = errors.filter((e) => !/status of 404/.test(e));
    expect(real, real.join('\n')).toEqual([]);
  });

  test('the dialogue is refused without the household code (401 from the proxy, no static copy)', async ({
    request,
  }) => {
    const base = 'http://localhost:3002/v1/textbook/laixue-1';
    expect((await request.get(`${base}/dialogues`)).status()).toBe(401);
    expect((await request.get(`${base}/examples`)).status()).toBe(401);
    // With the code: 200 if the private text is installed here, otherwise 404 — never 401.
    expect([200, 404]).toContain(
      (await request.get(`${base}/dialogues`, { headers: { 'x-site-code': 'tofu' } })).status(),
    );
    // Never a public static file.
    for (const p of ['/textbook/laixue-1/dialogues.json', '/textbook/laixue-1/private/dialogues.json', '/textbook/laixue-1/laixue-1.pdf']) {
      const res = await request.get(`http://localhost:5183${p}`);
      const ct = res.headers()['content-type'] ?? '';
      expect(ct.includes('json') || ct.includes('pdf'), p).toBe(false);
    }
  });

  test('Study this lesson runs vocab → grammar → scenario → journal, each step skippable', async ({ page }) => {
    await page.goto('/?page=textbook');
    await page.getByTestId('my-class-toggle').check();
    await page.getByTestId('my-class-lesson').selectOption('3');
    await expect(page.getByTestId('class-status')).toBeVisible();
    await page.getByTestId('lesson-3').getByRole('button').first().click();
    await page.getByTestId('study-lesson').click();

    await expect(page.getByTestId('study-session')).toContainText('Step 1 of 4');
    // Vocab: review a couple of cards, then continue.
    await page.getByRole('button', { name: 'Show answer' }).first().click();
    await page.getByRole('button', { name: 'Good' }).click();
    await page.getByRole('button', { name: /Done with vocabulary/ }).click();

    // Grammar: answer every exercise.
    await expect(page.getByTestId('study-session')).toContainText('Step 2 of 4');
    for (let i = 0; i < 12; i++) {
      const ex = page.getByTestId('grammar-exercise');
      if (!(await ex.isVisible())) break;
      const opt = ex.locator('.textbook-options button:not([disabled])').first();
      await opt.click();
      if (await ex.getByRole('button', { name: 'Check' }).count()) {
        // reorder: tap every remaining word in order, then Check
        const n = await ex.locator('.textbook-options button').count();
        for (let k = 1; k < n; k++) await ex.locator('.textbook-options button:not([disabled])').first().click();
        await ex.getByRole('button', { name: 'Check' }).click();
      }
      await page.getByTestId('grammar-next').click();
    }
    await expect(page.getByTestId('grammar-done')).toBeVisible();
    await page.getByTestId('grammar-done').click();

    // Scenario: the lesson's own chat scenario opens with the authored opener.
    await expect(page.getByTestId('study-session')).toContainText('Step 3 of 4');
    await expect(page.locator('.chat-bubble--npc').first()).toContainText('Lisa');
    await page.getByTestId('study-skip').click();

    // Journal: one of the lesson's prompts, with its pattern.
    await expect(page.getByTestId('study-session')).toContainText('Step 4 of 4');
    await expect(page.getByTestId('class-prompts')).toBeVisible();
    await page.getByTestId('study-skip').click(); // Finish
    await expect(page.getByTestId('study-lesson')).toBeVisible();
  });

  test('chat shows class scenarios only while My class is on; later lessons stay locked; Lesson focus in the reader', async ({
    page,
  }) => {
    await page.goto('/?page=chat');
    await expect(page.getByText("An'an chat")).toBeVisible();
    await expect(page.locator('.chat-class-section')).toHaveCount(0);
    await expect(page.getByText('Family')).toHaveCount(0);

    await page.goto('/?page=textbook');
    await page.getByTestId('my-class-toggle').check();
    await page.getByTestId('my-class-lesson').selectOption('2');
    await expect(page.getByTestId('class-status')).toBeVisible();

    await page.getByTestId('nav-textbook').waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByTestId('class-scenario-laixue-1-L02-siblings-chat')).toBeEnabled();
    await expect(page.getByTestId('class-scenario-laixue-1-L03-family-jobs')).toBeDisabled();
    await page.screenshot({ path: 'screenshots/textbook-chat.png' });

    await page.getByRole('button', { name: 'Reader', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Lesson' })).toBeVisible();
    await page.getByRole('radio', { name: 'Lesson' }).click();
    await page.getByRole('button', { name: /New sentence/ }).click();
    await expect(page.locator('.reader-reason, .reader-source').first()).toBeVisible();
    await page.screenshot({ path: 'screenshots/textbook-reader-lesson.png' });

    // Off again: everything back to normal.
    await page.getByRole('button', { name: /Textbook/ }).click();
    await page.getByTestId('my-class-toggle').uncheck();
    await page.getByRole('button', { name: 'Reader', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Lesson' })).toHaveCount(0);
  });

  test('the series: four books on one path, a book picker, "My class" at book 2 lesson 3 (Phase 13)', async ({
    page,
  }) => {
    await page.goto('/?page=textbook');
    await expect(page.getByTestId('book-picker')).toBeVisible();
    for (const n of [1, 2, 3, 4])
      await expect(page.getByTestId(`book-progress-laixue-${n}`)).toContainText('of 10 lessons done');
    await page.getByTestId('book-laixue-3').click(); // jumps to the book's section

    await page.getByTestId('my-class-toggle').check();
    await page.getByTestId('my-class-book').selectOption('laixue-2');
    await page.getByTestId('my-class-lesson').selectOption('3');
    await expect(page.getByTestId('class-status')).toContainText('lesson 3 of 來學華語 第二冊');
    // everything before it is "past", this lesson is now, the next trickles in, later ones are out
    await expect(page.getByTestId('lesson-10')).toHaveClass(/textbook-lesson--past/);
    await expect(page.getByTestId('lesson-laixue-2-3')).toHaveClass(/textbook-lesson--now/);
    await expect(page.getByTestId('lesson-laixue-2-4')).toHaveClass(/textbook-lesson--next/);
    await expect(page.getByTestId('lesson-laixue-2-5')).toHaveClass(/textbook-lesson--later/);
    // the header picker shows the book's level as a hint, and its label carries the CEFR band
    await expect(page.getByTestId('level-class-hint')).toContainText('A1');
    await expect(page.getByLabel('My level')).toContainText('L1 入門級 · A1');

    // "Study this lesson" works for a lesson of any book
    await page.getByTestId('lesson-laixue-2-3').getByRole('button').first().click();
    await expect(page.getByTestId('textbook-badge').first().or(page.getByText('來學華語 2 · L3').first())).toBeVisible();
    await expect(page.getByTestId('study-lesson')).toBeEnabled();
  });
});
