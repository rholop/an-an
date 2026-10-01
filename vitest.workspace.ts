import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/core/vitest.config.ts',
  'packages/data-pipeline/vitest.config.ts',
  'apps/web/vitest.config.ts',
]);
