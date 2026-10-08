import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: {
        evidence: { toArray: () => Promise<{ kind: string; item: { id: string } }[]> };
        turns: { toArray: () => Promise<{ role: string; zh: string }[]> };
      };
    };
  }
}

test.describe('Chat page', () => {
  test('scenario picker, opener, tap/hover evidence, and a fake-tutor reply', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?page=chat');
    await expect(page.getByText("An'an chat")).toBeVisible();
    await expect(page.getByText(/Your level:/)).toBeVisible({ timeout: 15000 });

    // No real API keys in this environment — use the fake tutor so the rest
    // of the UI (regeneration loop aside) can be exercised end to end.
    await page.getByLabel('Use fake tutor (dev, no API key needed)').check();

    await expect(page.locator('.chat-scenario-card')).not.toHaveCount(0);
    await page.getByText('Ordering a drink at a tea shop').click();

    // Ruby annotations interleave pinyin between tokens (e.g. "歡迎huān yíng光臨…"),
    // so match within a single token rather than a multi-token phrase.
    await expect(page.locator('.chat-bubble--npc').first()).toContainText('歡迎');
    await page.screenshot({ path: 'screenshots/chat-opener.png' });

    // Tap-to-lookup on the opener → chat_lookup_gloss evidence + popover.
    await page.locator('.chat-bubble--npc .an-token').first().click();
    await expect(page.locator('.an-popover')).toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).some(
          (e) => e.kind === 'chat_lookup_gloss',
        ),
      )
      .toBe(true);

    // Hover a different token whose reading is already shown → no hover evidence
    // (only clicks count while pinyin/zhuyin is visible).
    await page.locator('.chat-bubble--npc .an-token').nth(2).hover();
    await page.waitForTimeout(300);
    expect(
      (await page.evaluate(() => window.__anan.db.evidence.toArray())).some(
        (e) => e.kind === 'chat_hover_reading',
      ),
    ).toBe(false);

    // Send a learner turn; the fake tutor should reply.
    await page.locator('.chat-input').fill('我要一杯珍珠奶茶');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.chat-bubble--learner').first()).toContainText('珍珠');
    await expect(page.locator('.chat-bubble--npc').nth(1)).toContainText('需要', {
      timeout: 10000,
    });
    await page.screenshot({ path: 'screenshots/chat-after-reply.png' });

    // Dev debug drawer: validator report on the npc reply.
    await expect(page.locator('.chat-debug').first()).toContainText('coverage');

    // Suggested reply chips from the fake tutor's response.
    await expect(page.locator('.chat-chip').first()).toBeVisible();

    const turns = await page.evaluate(() => window.__anan.db.turns.toArray());
    expect(turns.map((t) => t.role)).toEqual(['npc', 'learner', 'npc']);

    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('a scenario can be completed end to end and produces a summary', async ({ page }) => {
    await page.goto('/?page=chat');
    await expect(page.getByText(/Your level:/)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Use fake tutor (dev, no API key needed)').check();
    await page.getByText('Ordering a drink at a tea shop').click();
    await expect(page.locator('.chat-bubble--npc').first()).toBeVisible();

    // The fake tutor's default script marks every goal step done by the 3rd
    // learner turn (with a fresh, empty learner model its canned reply never
    // passes validation, so every turn burns all maxRegenerations attempts).
    for (let i = 0; i < 3; i++) {
      const input = page.locator('.chat-input');
      if ((await input.count()) === 0) break; // already completed early
      await input.fill('我要一杯珍珠奶茶');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('.chat-input:not(:disabled)') !== null ||
          document.querySelector('.chat-summary') !== null,
        { timeout: 10000 },
      );
    }

    await expect(page.getByText('Chat finished')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.chat-bubble--npc').last()).toContainText('好了');
    await expect(page.getByText(/goals completed/)).toContainText('5/5 goals completed');
    await page.screenshot({ path: 'screenshots/chat-summary.png' });
  });
});
