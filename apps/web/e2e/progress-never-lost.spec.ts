import { rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startFreshIfAsked } from './gate.js';
import { syncDir } from './sync-dir.js';

/**
 * Phase 28 Part D: the owner's report, "When I cleared my cookies my progress went away". Against
 * the real proxy and a temp SYNC_DIR (playwright.config.ts): study, wait for "Saved", clear ALL
 * site data, come back, and everything is there.
 */

declare global {
  interface Window {
    __anan: {
      db: {
        items: { count: () => Promise<number>; toArray: () => Promise<{ item: { id: string }; skill: string }[]> };
        evidence: { count: () => Promise<number> };
        settings: { toArray: () => Promise<{ key: string; value: unknown }[]> };
        journalEntries: { toArray: () => Promise<{ text?: string; status: string }[]> };
      };
      learnerService: { record: (e: unknown, now: Date) => Promise<unknown> };
    };
    __ananSync: { flush: () => Promise<void>; saveNow: () => Promise<void>; status: string };
  }
}

test.describe.configure({ mode: 'serial' });

/** Each test starts and ends with nothing on the server for either profile (other specs count cards). */
const wipeServer = () => {
  for (const id of ['ron', 'guanyu']) rmSync(path.join(syncDir(), id), { recursive: true, force: true });
};
test.beforeEach(wipeServer);
test.afterEach(wipeServer);

async function signIn(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Household code').fill('tofu');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name }).click();
  await startFreshIfAsked(page, name);
  await expect(page.getByTestId('profile-chip')).toContainText(name, { timeout: 20000 });
  await page.waitForFunction(() => Boolean(window.__anan && window.__ananSync));
}

const learn = (page: Page, ids: string[]) =>
  page.evaluate(async (words) => {
    for (const id of words)
      await window.__anan.learnerService.record(
        { item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: new Date() },
        new Date(),
      );
  }, ids);

const snapshot = (page: Page) =>
  page.evaluate(async () => ({
    items: (await window.__anan.db.items.toArray()).map((r) => `${r.item.id}|${r.skill}`).sort(),
    evidence: await window.__anan.db.evidence.count(),
    settings: Object.fromEntries(
      (await window.__anan.db.settings.toArray())
        .filter((s) => ['currentLevel', 'readingSettings', 'myClass', 'journalDraft'].includes(s.key))
        .map((s) => [s.key, JSON.stringify(s.value)]),
    ),
    journal: (await window.__anan.db.journalEntries.toArray()).map((j) => `${j.status}:${j.text ?? ''}`).sort(),
  }));

/** What "clear site data" does: IndexedDB, local/session storage, service workers and cookies. */
async function clearSiteData(ctx: BrowserContext, page: Page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin: 'http://localhost:5183', storageTypes: 'all' });
  await ctx.clearCookies();
}

test('clearing all site data loses nothing: the server copy comes back complete', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'clears site data through the Chromium DevTools protocol');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, '冠宇');

  // study: cards Learned, a journal draft, settings changed
  await learn(page, ['keep-apple', 'keep-banana', 'keep-cherry', 'keep-durian']);
  await page.getByRole('button', { name: 'Reader' }).click();
  await page.getByLabel('My level').selectOption('L2');
  await page.getByRole('button', { name: 'Journal' }).click();
  await page.getByLabel('Journal entry').fill('我今天去捷運站。');
  await page.waitForTimeout(600); // the draft's own save timer
  await page.evaluate(() => window.__ananSync.saveNow());
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved');
  const before = await snapshot(page);
  expect(before.items.length).toBeGreaterThanOrEqual(4);
  expect(before.settings.journalDraft).toContain('我今天去捷運站');

  await clearSiteData(ctx, page);
  await page.reload();
  await page.getByLabel('Household code').fill('tofu');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: '冠宇' }).click();
  // a copy was found, so there is no "start fresh" question
  await expect(page.getByTestId('profile-chip')).toContainText('冠宇', { timeout: 20000 });
  await expect(page.getByTestId('gate-restore')).toHaveCount(0);
  await page.waitForFunction(() => Boolean(window.__anan));
  expect(await snapshot(page)).toEqual(before);
  await ctx.close();
});

test('closing the tab 2 s after an answer loses nothing: reopened, it is there and reaches the server', async ({
  browser,
  request,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, '羅恩');
  await learn(page, ['closed-tab-word']);
  await page.waitForTimeout(2000); // before the 5 s quiet period ends
  await page.close({ runBeforeUnload: true });

  const again = await ctx.newPage();
  await again.goto('/');
  await expect(again.getByTestId('profile-chip')).toContainText('羅恩', { timeout: 20000 });
  await again.waitForFunction(() => Boolean(window.__anan));
  expect((await again.evaluate(() => window.__anan.db.items.toArray())).map((r) => r.item.id)).toContain('closed-tab-word');
  await expect(again.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved', { timeout: 20000 });
  const server = await (await request.get('http://localhost:3002/v1/sync/ron', { headers: { 'x-site-code': 'tofu' } })).json();
  expect((server.data.items as { item: { id: string } }[]).map((i) => i.item.id)).toContain('closed-tab-word');
  await ctx.close();
});

test('a fresh browser never opens silently empty: no copy, or no server, says so', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Household code').fill('tofu');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: '羅恩' }).click();
  await expect(page.getByTestId('gate-restore')).toContainText('No saved progress found on the server for 羅恩');

  // the server can't be reached: Try again, or Start fresh
  await page.route('**/v1/sync/**', (route) => route.abort());
  await page.getByTestId('gate-try-again').click();
  await expect(page.getByTestId('gate-restore')).toContainText("Couldn't reach the server");
  await page.unroute('**/v1/sync/**');
  await page.getByTestId('gate-start-fresh').click();
  await expect(page.getByTestId('profile-chip')).toContainText('羅恩');
  await ctx.close();
});

test('a save the server refuses as too big says so in words, with Save now', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, '羅恩');
  await page.route('**/v1/sync/ron', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 413, body: '{"error":"too large"}' }) : route.fallback(),
  );
  await learn(page, ['too-big-word']);
  await page.evaluate(() => window.__ananSync.saveNow());
  const cloud = page.getByTestId('sync-dot');
  await expect(cloud).toContainText(/Not saved for/);
  await cloud.click();
  await expect(page.getByTestId('sync-reason')).toContainText('too big to save to the server');

  await page.unroute('**/v1/sync/ron');
  await page.getByTestId('sync-save-now').click();
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-state', 'saved');
  await ctx.close();
});
