import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    root: __dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
