import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 25 architecture test: the app never calls the paid provider (the owner's decision). No file
 * imports its SDK, no code reads its settings, no package depends on it, and the name appears only
 * in CHANGELOG.md. (The name is assembled here so this file does not match itself.)
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NAME = ['open', 'ai'].join('');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'raw', 'test-results', 'playwright-report', 'sync-data', 'audio-data', 'build']);
const EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md)$/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (EXT.test(name) && st.size < 5_000_000) yield p;
  }
}

describe('Gemini only (Phase 25)', () => {
  it(`no file outside CHANGELOG.md mentions ${'the paid provider'}`, () => {
    const hits: string[] = [];
    const re = new RegExp(NAME, 'i');
    for (const f of files(ROOT)) {
      const rel = path.relative(ROOT, f);
      if (rel === 'CHANGELOG.md') continue;
      if (re.test(readFileSync(f, 'utf8'))) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it('no package depends on its SDK and the lockfile does not carry it', () => {
    const lock = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(new RegExp(`\\b${NAME}@`, 'i').test(lock)).toBe(false);
  });
});
