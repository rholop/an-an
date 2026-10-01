import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'data-pipeline',
    root: __dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
