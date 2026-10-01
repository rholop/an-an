import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    root: __dirname,
    environment: 'node',
    setupFiles: ['./src/db/test-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
