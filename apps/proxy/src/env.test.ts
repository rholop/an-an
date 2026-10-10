import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAINS, ignoredLegacyModels, loadEnv, resolveChains } from './env.js';

describe('loadEnv', () => {
  it('has a chain of Gemini models per role (Phase 33)', () => {
    const chains = resolveChains(loadEnv({}));
    for (const chain of Object.values(chains)) {
      expect(chain.length).toBeGreaterThan(1);
      for (const m of chain) expect(m).toMatch(/^gemini-/);
    }
  });

  it('default chains: the story writer and the checker never start on the same model', () => {
    expect(DEFAULT_CHAINS.story[0]).not.toBe(DEFAULT_CHAINS.check[0]);
    // three models, four roles: only one pair can share a start (the two live roles)
    const starts = Object.values(DEFAULT_CHAINS).map((c) => c[0]);
    expect(new Set(starts).size).toBe(new Set(Object.values(DEFAULT_CHAINS).flat()).size);
    expect(DEFAULT_CHAINS.turn[0]).toBe(DEFAULT_CHAINS.journal[0]);
  });

  it('reads GEMINI_CHAIN_* lists and puts GEMINI_MODEL_FALLBACK last', () => {
    const chains = resolveChains(
      loadEnv({ GEMINI_CHAIN_CHECK: 'gemini-a, gemini-b', GEMINI_MODEL_FALLBACK: 'gemini-x' }),
    );
    expect(chains.check).toEqual(['gemini-a', 'gemini-b', 'gemini-x']);
    expect(chains.story.at(-1)).toBe('gemini-x');
    // already in the chain: not repeated
    expect(resolveChains(loadEnv({ GEMINI_CHAIN_TURN: 'gemini-x,gemini-y', GEMINI_MODEL_FALLBACK: 'gemini-x' })).turn).toEqual([
      'gemini-x',
      'gemini-y',
    ]);
  });

  it('names the old one-model settings it no longer reads', () => {
    expect(ignoredLegacyModels(loadEnv({ GEMINI_MODEL_CHECK: 'gemini-2.5-flash' }))).toEqual(['GEMINI_MODEL_CHECK']);
    expect(ignoredLegacyModels(loadEnv({}))).toEqual([]);
  });
});
