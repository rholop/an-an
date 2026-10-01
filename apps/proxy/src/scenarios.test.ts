import { describe, expect, it } from 'vitest';
import { loadScenarioStore } from './scenarios.js';

describe('loadScenarioStore', () => {
  it('loads the real data/build/scenarios.json (run `pnpm pipeline:build` if this fails)', () => {
    const store = loadScenarioStore();
    const ids = store.all().map((s) => s.id).sort();
    expect(ids).toEqual(['easycard-topup', 'tea-shop']);
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
