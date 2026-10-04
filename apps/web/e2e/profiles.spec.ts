import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __anan: {
      db: {
        items: { count: () => Promise<number> };
        settings: { get: (k: string) => Promise<{ value: unknown } | undefined> };
      };
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
      profileId: string;
    };
  }
}

/** Pure local mode: these specs are about the gate and switching, not the server. */
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    if (localStorage.getItem('anan.sync.disabled') === null)
      localStorage.setItem('anan.sync.disabled', '1');
    localStorage.setItem('anan.study.disabled', '1'); // Phase 14: plain queues for these specs
  });
});

test.describe('household code, who are you, switching', () => {
  test('asks for the code once; a wrong one says so and lets you try again; the right one is remembered', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByLabel('Household code')).toBeVisible();
    await expect(page.getByRole('button', { name: '羅恩' })).toHaveCount(0); // code comes before the names

    await page.getByLabel('Household code').fill('nope');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText("That's not it")).toBeVisible();

    await page.getByLabel('Household code').fill('tofu');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: '羅恩' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('anan.siteCode'))).toBe('tofu');

    // never asked again on this browser
    await page.reload();
    await expect(page.getByLabel('Household code')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '羅恩' })).toBeVisible();
  });

  test('first visit shows the two names only; choosing goes in, and a reload goes straight into that profile', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('anan.siteCode', 'tofu'));
    await page.goto('/');
    const names = page.locator('.gate-big');
    await expect(names).toHaveText(['羅恩', '冠宇']);
    await expect(page.locator('.gate')).not.toContainText('Household code');

    await names.nth(1).click();
    await expect(page.getByTestId('profile-chip')).toContainText('冠宇', { timeout: 15000 });
    expect(await page.evaluate(() => localStorage.getItem('anan.profile'))).toBe('guanyu');

    await page.reload();
    await expect(page.getByTestId('profile-chip')).toContainText('冠宇', { timeout: 15000 });
    await expect(page.locator('.gate-big')).toHaveCount(0);
  });

  test('reviews as 羅恩, switch to 冠宇 (untouched), switch back (intact) — no page reload', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
      localStorage.setItem('anan.siteCode', 'tofu');
      if (localStorage.getItem('anan.profile') === null)
        localStorage.setItem('anan.profile', 'ron');
    });
    await page.goto('/?page=reader');
    await expect(page.getByTestId('profile-chip')).toContainText('羅恩', { timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.__anan));
    expect(await page.evaluate(() => window.__anan.profileId)).toBe('ron');

    await page.evaluate(async () => {
      for (const id of ['x1', 'x2', 'x3']) {
        await window.__anan.learnerService.record(
          {
            item: { kind: 'word', id },
            skill: 'recognition',
            kind: 'chat_lookup_gloss',
            at: new Date(),
          },
          new Date(),
        );
      }
      await window.__anan.db.settings.get('x'); // flush
    });
    expect(await page.evaluate(() => window.__anan.db.items.count())).toBe(3);
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1)); // proves no full reload

    const switchTo = async (name: string) => {
      await page.getByTestId('profile-chip').click();
      await page.getByRole('menuitem', { name }).click();
      await expect(page.getByTestId('profile-chip')).toContainText(name, { timeout: 15000 });
      await page.waitForFunction(() => Boolean(window.__anan));
    };

    await switchTo('冠宇');
    expect(await page.evaluate(() => window.__anan.profileId)).toBe('guanyu');
    expect(await page.evaluate(() => window.__anan.db.items.count())).toBe(0); // 冠宇's untouched queue
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText(/Nothing due right now/)).toBeVisible();

    await switchTo('羅恩');
    expect(await page.evaluate(() => window.__anan.db.items.count())).toBe(3); // intact
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText(/3 due now/)).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('level and display settings are per profile; an unsent journal draft is saved on switching', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('anan.siteCode', 'tofu');
      if (localStorage.getItem('anan.profile') === null)
        localStorage.setItem('anan.profile', 'ron');
    });
    await page.goto('/?page=reader');
    await expect(page.getByText(/Lexicon v2/)).toBeVisible({ timeout: 20000 });
    await page.getByLabel('My level').selectOption('L3');
    await page.locator('.reader-controls select').nth(1).selectOption('zhuyin');

    await page.getByRole('button', { name: 'Journal' }).click();
    await page.getByLabel('Journal entry').fill('今天我很高興');
    // switch immediately — before the draft's own 400ms save timer
    await page.getByTestId('profile-chip').click();
    await page.getByRole('menuitem', { name: '冠宇' }).click();
    await expect(page.getByTestId('profile-chip')).toContainText('冠宇', { timeout: 15000 });

    await expect(page.getByLabel('My level')).toHaveValue('N1'); // 冠宇 has chosen nothing yet
    await page.getByRole('button', { name: 'Journal' }).click();
    await expect(page.getByLabel('Journal entry')).toHaveValue('');
    await page.getByRole('button', { name: 'Reader' }).click();
    await expect(page.locator('.reader-controls select').nth(1)).toHaveValue('pinyin');

    await page.getByTestId('profile-chip').click();
    await page.getByRole('menuitem', { name: '羅恩' }).click();
    await expect(page.getByTestId('profile-chip')).toContainText('羅恩', { timeout: 15000 });
    await expect(page.getByLabel('My level')).toHaveValue('L3');
    await page.getByRole('button', { name: 'Journal' }).click();
    await expect(page.getByLabel('Journal entry')).toHaveValue('今天我很高興'); // saved on switch
    await page.getByRole('button', { name: 'Reader' }).click();
    await expect(page.locator('.reader-controls select').nth(1)).toHaveValue('zhuyin');
  });
});
