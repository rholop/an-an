import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { collectFindings, prepareContext, ROUTES, type Finding, type Theme } from './support.js';

/**
 * Phase 11 step 0: screenshot every route in light and dark and list what is
 * wrong. Only runs when MOBILE_AUDIT is set to "before" or "after":
 *
 *   MOBILE_AUDIT=before pnpm --filter @anan/web exec playwright test e2e/mobile/audit.spec.ts
 *
 * Writes docs/mobile-audit/<phase>/<project>/<theme>-<route>.jpg and
 * findings-<project>.json (turned into docs/mobile-audit.md by
 * scripts/mobile-audit-report.mjs).
 */
const phase = process.env.MOBILE_AUDIT;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/mobile-audit');

test.skip(!phase, 'set MOBILE_AUDIT=before|after to run the audit');
test.describe.configure({ mode: 'parallel' });

const results: Record<string, Finding[]> = {};

for (const theme of ['light', 'dark'] as Theme[]) {
  for (const route of ROUTES) {
    test(`${route.id} (${theme})`, async ({ page }, testInfo) => {
      test.setTimeout(60000);
      await prepareContext(page, route.session, theme);
      await route.run(page);
      await page.waitForTimeout(500);
      const dir = path.join(OUT, phase!, testInfo.project.name);
      mkdirSync(dir, { recursive: true });
      // JPEG at CSS pixel size (390–430px wide): small enough to commit for every route
      await page.screenshot({
        path: path.join(dir, `${theme}-${route.id}.jpg`),
        fullPage: true,
        type: 'jpeg',
        quality: route.highRes ? 70 : 78,
        scale: route.highRes ? 'device' : 'css',
      });
      const findings = await collectFindings(page);
      mkdirSync(path.join(OUT, phase!, 'findings'), { recursive: true });
      writeFileSync(
        path.join(OUT, phase!, 'findings', `${testInfo.project.name}__${theme}__${route.id}.json`),
        JSON.stringify(findings, null, 2),
      );
      results[`${theme}__${route.id}`] = findings;
    });
  }
}
