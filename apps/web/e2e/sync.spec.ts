import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __anan: {
      db: {
        items: { count: () => Promise<number>; toArray: () => Promise<{ item: { id: string } }[]> };
        evidence: { count: () => Promise<number> };
      };
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
    };
    __ananSync: { flush: () => Promise<void>; status: string; lastRev: number };
  }
}

const WORDS = ['sync-apple', 'sync-banana', 'sync-cherry'];

async function signIn(page: import('@playwright/test').Page, name: string, code = 'tofu') {
  await page.goto('/');
  await page.getByLabel('Household code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('profile-chip')).toContainText(name, { timeout: 20000 });
  await page.waitForFunction(() => Boolean(window.__anan && window.__ananSync));
  // The opening screen (Home) has finished loading its code, so going offline later can't break it.
  await expect(page.locator('.page-slot .page-loading')).toHaveCount(0);
  await expect(page.locator('.page-slot > *').first()).toBeVisible();
}

test.describe('sync between browsers (phase 8)', () => {
  test('progress made in browser A appears in a clean browser B after picking the same name', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await signIn(a, '冠宇');
    await a.evaluate(async (words) => {
      for (const id of words) {
        await window.__anan.learnerService.record(
          { item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: new Date() },
          new Date(),
        );
      }
      await window.__ananSync.flush(); // the 30s debounce is for humans; force the push
    }, WORDS);
    expect(await a.evaluate(() => window.__ananSync.status)).toBe('synced');

    // B has never seen this app: code + name is all it takes
    await signIn(b, '冠宇');
    expect(await b.evaluate(() => window.__anan.db.items.count())).toBe(3);
    expect(
      (await b.evaluate(() => window.__anan.db.items.toArray())).map((r) => r.item.id).sort(),
    ).toEqual(WORDS);
    expect(await b.evaluate(() => window.__anan.db.evidence.count())).toBe(3);

    // the other profile on B is untouched by 冠宇's data
    await b.getByTestId('profile-chip').click();
    await b.getByRole('menuitem', { name: '羅恩' }).click();
    await expect(b.getByTestId('profile-chip')).toContainText('羅恩', { timeout: 15000 });
    await b.waitForFunction(() => Boolean(window.__anan));
    expect(await b.evaluate(() => window.__anan.db.items.count())).toBe(0);

    await ctxA.close();
    await ctxB.close();
  });

  test('offline: the app keeps working, the "not synced" dot appears and clears after reconnecting', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, '羅恩');
    await expect(page.getByTestId('sync-dot')).toHaveCount(0);

    await ctx.setOffline(true);
    await page.evaluate(async () => {
      await window.__anan.learnerService.record(
        {
          item: { kind: 'word', id: 'offline-word' },
          skill: 'recognition',
          kind: 'review_good',
          at: new Date(),
        },
        new Date(),
      );
      await window.__ananSync.flush().catch(() => undefined);
    });
    await expect(page.getByTestId('sync-dot')).toBeVisible();
    expect(await page.evaluate(() => window.__anan.db.items.count())).toBe(1); // never blocked

    await ctx.setOffline(false);
    await page.evaluate(() => window.__ananSync.flush());
    await expect(page.getByTestId('sync-dot')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ananSync.status)).toBe('synced');
    await ctx.close();
  });

  test('two browsers editing different records offline both survive once both sync', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await signIn(a, '冠宇');
    await signIn(b, '冠宇');
    const learn = (p: typeof a, id: string) =>
      p.evaluate(async (wid) => {
        await window.__anan.learnerService.record(
          {
            item: { kind: 'word', id: wid },
            skill: 'recognition',
            kind: 'review_good',
            at: new Date(),
          },
          new Date(),
        );
      }, id);
    await ctxA.setOffline(true);
    await ctxB.setOffline(true);
    await learn(a, 'only-on-a');
    await learn(b, 'only-on-b');
    await ctxA.setOffline(false);
    await ctxB.setOffline(false);
    await a.evaluate(() => window.__ananSync.flush());
    await b.evaluate(() => window.__ananSync.flush()); // stale → 409 → merge → push
    await a.evaluate(() => window.__ananSync.flush());
    for (const p of [a, b]) {
      const ids = (await p.evaluate(() => window.__anan.db.items.toArray())).map((r) => r.item.id);
      expect(ids).toEqual(expect.arrayContaining(['only-on-a', 'only-on-b']));
    }
    await ctxA.close();
    await ctxB.close();
  });

  test('a wrong or changed household code is rejected by the server and the site asks again', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      localStorage.setItem('anan.siteCode', 'old-code');
      localStorage.setItem('anan.profile', 'ron');
    });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByLabel('Household code')).toBeVisible({ timeout: 20000 }); // sync got a 401
    expect(await page.evaluate(() => localStorage.getItem('anan.siteCode'))).toBeNull();
    await ctx.close();
  });
});
