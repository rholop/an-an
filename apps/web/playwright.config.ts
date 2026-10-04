import { defineConfig, devices } from '@playwright/test';
import { syncDir } from './e2e/sync-dir.js';

export default defineConfig({
  testDir: './e2e',
  timeout: 15000,
  globalSetup: './e2e/global-setup.ts',
  webServer: [
    {
      command: 'pnpm exec vite --port 5183',
      port: 5183,
      reuseExistingServer: true,
    },
    {
      // The real proxy (no AI keys: AI calls fail, sync works) so the sync and
      // household-code specs exercise the actual endpoints.
      command: 'pnpm --filter @anan/proxy exec tsx src/server.ts',
      port: 3002,
      reuseExistingServer: true,
      env: {
        SITE_CODE: 'tofu',
        PORT: '3002',
        CORS_ORIGIN: 'http://localhost:5183',
        SYNC_DIR: syncDir(),
        RATE_LIMIT_PER_MINUTE: '1000',
      },
    },
  ],
  use: {
    baseURL: 'http://localhost:5183',
  },
  projects: [
    // The existing suite: desktop Chromium.
    { name: 'desktop', testIgnore: 'mobile/**' },
    // Phase 11: the app only needs to work in Safari and Chrome on newer
    // iPhones. Chrome on iOS is WebKit too, so ONE engine covers both — the
    // two projects are a small and a large current iPhone. Real WebKit (not
    // Chromium emulating an iPhone), so Safari-only layout bugs show up here.
    { name: 'iphone-13', testMatch: 'mobile/**/*.spec.ts', use: { ...devices['iPhone 13'] } },
    {
      name: 'iphone-15-pro-max',
      testMatch: 'mobile/**/*.spec.ts',
      use: { ...devices['iPhone 15 Pro Max'] },
    },
  ],
});
