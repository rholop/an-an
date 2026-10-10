import { test as base, expect } from '@playwright/test';

/**
 * Most specs aren't about profiles or sync: they start already "signed in" as
 * 羅恩 with the household code entered and sync switched off (so parallel
 * specs never share one server copy). Specs for the gate and for sync import
 * plain `@playwright/test` instead.
 */
/**
 * Phase 23: review comes in two sessions (morning, evening) in the profile's time zone. Specs run
 * at any hour, so the fixture picks a zone where it is about 18:00 now: inside the evening
 * session, whose cards are everything due before tomorrow 10:00. (Etc/GMT-k is UTC+k.)
 */
export function eveningZone(now: Date = new Date()): string {
  let k = 18 - now.getUTCHours();
  if (k > 14) k -= 24;
  if (k < -12) k += 24;
  return k === 0 ? 'Etc/GMT' : `Etc/GMT${k > 0 ? '-' : '+'}${Math.abs(k)}`;
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript((zone: string) => {
      const setIfAbsent = (k: string, v: string) => {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      };
      setIfAbsent('anan.siteCode', 'tofu');
      setIfAbsent('anan.profile', 'ron');
      setIfAbsent('anan.sync.disabled', '1');
      // Phase 14: the study order reorders queues; specs written for the plain queues switch it off
      // (the study-order specs remove this key).
      setIfAbsent('anan.study.disabled', '1');
      // Phase 15: listening exercises add steps and slots; specs for the plain flows switch them off.
      setIfAbsent('anan.listening.disabled', '1');
      setIfAbsent('anan.sessions.defaultZone', zone);
    }, eveningZone());
    await use(context);
  },
});

export { expect };

/**
 * Phase 30: opens a screen from the top nav. On a laptop the nav moves the items that don't fit into
 * More (how many fit depends on the fonts and the Textbook label), so look there too.
 */
export async function goNav(page: import('@playwright/test').Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const inBar = nav.getByRole('button', { name, exact: true });
  if (await inBar.isVisible()) return inBar.click();
  await page.getByTestId('nav-more').click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name, exact: true }).click();
}
