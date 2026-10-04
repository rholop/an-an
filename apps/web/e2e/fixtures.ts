import { test as base, expect } from '@playwright/test';

/**
 * Most specs aren't about profiles or sync: they start already "signed in" as
 * 羅恩 with the household code entered and sync switched off (so parallel
 * specs never share one server copy). Specs for the gate and for sync import
 * plain `@playwright/test` instead.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      const setIfAbsent = (k: string, v: string) => {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      };
      setIfAbsent('anan.siteCode', 'tofu');
      setIfAbsent('anan.profile', 'ron');
      setIfAbsent('anan.sync.disabled', '1');
      // Phase 14: the study order reorders queues; specs written for the plain queues switch it off
      // (the study-order specs remove this key).
      setIfAbsent('anan.study.disabled', '1');
    });
    await use(context);
  },
});

export { expect };
