import { describe, expect, it } from 'vitest';
import { loadScenarioStore } from './scenarios.js';

describe('loadScenarioStore', () => {
  it('loads the real data/build/scenarios.json (run `pnpm pipeline:build` if this fails)', () => {
    const store = loadScenarioStore();
    const ids = store
      .all()
      .map((s) => s.id)
      // Phase 12/13 add generated textbook scenarios (laixue-1-* … laixue-4-*); the proxy must know them too.
      .filter((id) => !id.startsWith('laixue-'))
      .sort();
    expect(ids).toEqual([
      'clinic-call',
      'convenience-store',
      'easycard-topup',
      'landlord-deposit',
      'night-market',
      'tea-shop',
      'youbike',
    ]);
  });

  it('knows the textbook scenarios of all four books (the proxy resolves NPC details server-side)', () => {
    const store = loadScenarioStore();
    for (const book of ['laixue-1', 'laixue-2', 'laixue-3', 'laixue-4']) {
      const tb = store.all().filter((s) => s.id.startsWith(`${book}-`));
      expect(tb.length, book).toBeGreaterThanOrEqual(10);
      expect(tb.every((s) => s.textbook?.textbookId === book)).toBe(true);
    }
  });

  it('get() resolves a known scenario by id', () => {
    const store = loadScenarioStore();
    expect(store.get('tea-shop')?.title).toContain('tea shop');
  });

  it('get() returns undefined for an unknown id', () => {
    const store = loadScenarioStore();
    expect(store.get('does-not-exist')).toBeUndefined();
  });
});
