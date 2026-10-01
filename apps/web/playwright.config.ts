import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 15000,
  webServer: {
    command: 'pnpm exec vite --port 5183',
    port: 5183,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:5183',
  },
});
