// @ts-check
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/data/build/**', '**/*.config.js'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // tsc already catches genuinely undefined identifiers in value
      // position, far more accurately than ESLint can — plain `no-undef`
      // only produces false positives on ambient type-only globals like
      // `NodeJS` (used in e.g. `NodeJS.ProcessEnv`).
      'no-undef': 'off',
    },
  },
  {
    // packages/data-pipeline, apps/proxy, and config scripts run under Node.
    files: ['packages/data-pipeline/**/*.ts', 'apps/proxy/**/*.ts', '**/*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/data-pipeline/**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // apps/web runs in the browser.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/web/scripts/**/*.mjs', 'apps/web/playwright.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // e2e specs run under Node (Playwright test runner) but also reference
    // browser globals inside page.evaluate() closures.
    files: ['apps/web/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // packages/core must stay platform-agnostic: no DOM, no Dexie, no Node builtins, no fetch.
    // (Absence of "dom"/node types from its tsconfig catches globals like `document`/`fetch`/`window`
    // at the type-check level; this rule catches explicit imports of the same.)
    files: ['packages/core/**/*.ts'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'dexie', message: 'core must stay storage-agnostic; define an interface instead.' },
            { name: 'react', message: 'core must stay UI-agnostic.' },
          ],
          patterns: ['node:*'],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'core has no DOM.' },
        { name: 'window', message: 'core has no DOM.' },
        { name: 'fetch', message: 'core must not perform network I/O.' },
        { name: 'localStorage', message: 'core has no DOM.' },
        { name: 'indexedDB', message: 'core must stay storage-agnostic.' },
      ],
    },
  },
];
