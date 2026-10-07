import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __anan: {
      db: {
        conversations: { toArray: () => Promise<{ kind?: string; topic?: string; endedAt?: unknown }[]> };
        turns: { toArray: () => Promise<{ role: string; zh: string }[]> };
        evidence: { toArray: () => Promise<{ kind: string }[]> };
      };
    };
  }
}

const picker = (page: import('@playwright/test').Page) => page.getByLabel('My level');

test.describe('Open chat (phase 18)', () => {
  test('the Open chat card sits above the scenarios; topic screen, a reply, a new topic, and the summary', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?page=chat');
    await expect(page.getByText(/Your level:/)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Use fake tutor (dev, no API key needed)').check();

    // The card is above the first scenario card.
    const card = page.getByTestId('open-chat-card');
    await expect(card).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    const firstScenario = (await page.locator('.chat-scenario-card').first().boundingBox())!;
    expect(cardBox.y).toBeLessThan(firstScenario.y);

    await card.click();
    await expect(page.getByText('What do you want to talk about?')).toBeVisible();
    await expect(page.getByTestId('open-chat-privacy')).toContainText("Don't share anything private");
    const chips = page.getByTestId('open-chat-chips').locator('.chat-chip:not(.open-just-chat)');
    expect(await chips.count()).toBeGreaterThan(0);
    expect(await chips.count()).toBeLessThanOrEqual(8);
    await expect(page.getByRole('button', { name: 'Just chat' })).toBeVisible();

    await page.getByTestId('open-chat-topic-input').fill('my weekend');
    await page.getByRole('button', { name: 'Start' }).click();

    // 安安 opens; tap-to-lookup works like a scenario.
    await expect(page.getByTestId('open-chat')).toBeVisible();
    await expect(page.locator('.chat-header h1')).toContainText('my weekend');
    await expect(page.locator('.chat-bubble--npc').first()).toBeVisible();
    await page.locator('.chat-bubble--npc .an-token').first().click();
    await expect(page.locator('.an-popover')).toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.__anan.db.evidence.toArray())).some(
          (e) => e.kind === 'chat_lookup_gloss',
        ),
      )
      .toBe(true);

    // No goal checklist.
    await expect(page.locator('.chat-goals')).toHaveCount(0);

    await page.locator('.chat-input').fill('我喜歡吃飯');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.chat-bubble--npc').nth(1)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('open-chat-debug').first()).toContainText('A-share');

    // New topic keeps the same conversation.
    await page.getByRole('button', { name: 'New topic' }).click();
    await page.getByTestId('open-chat-topic-input').fill('family');
    await page.getByRole('button', { name: 'Switch' }).click();
    await expect(page.locator('.chat-header h1')).toContainText('family');

    await page.getByRole('button', { name: 'End chat' }).click();
    await expect(page.getByTestId('open-chat-summary')).toBeVisible();
    await expect(page.getByTestId('open-chat-tier-mix')).toContainText('words you know or are learning soon');

    // Saved as an open conversation with its topic, so history and cloze can use it.
    const convs = await page.evaluate(() => window.__anan.db.conversations.toArray());
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ kind: 'open', topic: 'family' });
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);

    // Back to the chats; the privacy note was shown once only.
    await page.getByRole('button', { name: '← Chats' }).click();
    await page.getByTestId('open-chat-card').click();
    await expect(page.getByTestId('open-chat-privacy')).toHaveCount(0);
  });

  test('"Just chat" starts without a topic', async ({ page }) => {
    await page.goto('/?page=chat');
    await expect(page.getByText(/Your level:/)).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Use fake tutor (dev, no API key needed)').check();
    await page.getByTestId('open-chat-card').click();
    await page.getByRole('button', { name: 'Just chat' }).click();
    await expect(page.locator('.chat-header h1')).toContainText('Just chat');
    await expect(page.locator('.chat-bubble--npc').first()).toContainText('？');
  });

  test('changing the header level changes the topic chips without a reload', async ({ page }) => {
    await page.goto('/?page=chat');
    await expect(page.getByText(/Your level:/)).toBeVisible({ timeout: 15000 });
    await picker(page).selectOption('N1');
    await page.getByTestId('open-chat-card').click();
    const labels = () =>
      page.getByTestId('open-chat-chips').locator('.chat-chip:not(.open-just-chat)').allTextContents();
    await expect.poll(async () => (await labels()).length).toBeGreaterThan(0);
    const n1 = await labels();
    // The level picker is in the app header (still on screen on wide layouts).
    await picker(page).selectOption('L4');
    await expect.poll(async () => (await labels()).join('|')).not.toBe(n1.join('|'));
    expect(await labels()).toEqual(expect.arrayContaining(['Work']));
  });
});
