import { describe, expect, it, vi } from 'vitest';
import { PromptCache } from './cache.js';
import type { ProviderResult } from './providers/types.js';
import { fakeTurnResponse } from './providers/fake.js';

function result(): ProviderResult {
  return { response: fakeTurnResponse(), provider: 'gemini', model: 'fake', usage: { inputTokens: 1, outputTokens: 1 } };
}

describe('PromptCache', () => {
  it('keyFor is deterministic for the same prompt+history and differs otherwise', () => {
    const a = PromptCache.keyFor('system', '[]');
    const b = PromptCache.keyFor('system', '[]');
    const c = PromptCache.keyFor('different system', '[]');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('get returns undefined for a key never set', () => {
    expect(new PromptCache().get('nope')).toBeUndefined();
  });

  it('set then get round-trips the exact result', () => {
    const cache = new PromptCache();
    const r = result();
    cache.set('k', r);
    expect(cache.get('k')).toEqual(r);
  });

  it('entries expire after the configured TTL', () => {
    vi.useFakeTimers();
    try {
      const cache = new PromptCache(1000);
      cache.set('k', result());
      expect(cache.get('k')).toBeDefined();
      vi.advanceTimersByTime(1001);
      expect(cache.get('k')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keyForPrompt is deterministic for the same prompt and differs otherwise', () => {
    const a = PromptCache.keyForPrompt('system');
    const b = PromptCache.keyForPrompt('system');
    const c = PromptCache.keyForPrompt('different system');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('works generically over a non-ProviderResult type (e.g. SentenceProviderResult)', () => {
    const cache = new PromptCache<{ value: number }>();
    cache.set('k', { value: 42 });
    expect(cache.get('k')).toEqual({ value: 42 });
  });
});
