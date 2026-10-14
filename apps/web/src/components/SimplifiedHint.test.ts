import { describe, expect, it } from 'vitest';
import { loadSimplifier } from '../lib/opencc.js';
import { simplifiedOf } from './SimplifiedHint.js';

describe('Phase 41: simplified hint', () => {
  it.each([
    ['餅乾', '饼干'],
    ['簡', '简'],
    ['捷運', '捷运'],
    ['計程車', '计程车'],
    ['還', '还'],
    ['長', '长'],
    // characters only, no phrase swaps: 軟體 stays 软体, never 软件
    ['軟體', '软体'],
    // the same: nothing extra
    ['可以', ''],
    ['吃', ''],
    ['早餐', ''],
    ['便利商店', ''],
    ['了', ''],
    ['V + 了', ''],
  ])('%s → %s', async (tw, cn) => {
    const convert = await loadSimplifier();
    expect(simplifiedOf(tw, convert)).toBe(cn);
  });

  it('shows nothing before the converter has loaded', () => {
    expect(simplifiedOf('餅乾', undefined)).toBe('');
  });
});
