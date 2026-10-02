import { defineConfig } from '@playwright/test';
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
});
