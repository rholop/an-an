import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiPausedUntil, quotaResetFrom } from './ai-quota.js';
import { aiQuotaUsedUntil } from './labels.js';
import { storyErrorText } from './story-errors.js';
import { aiErrorText, FetchTutorLLM, ProxyTurnError } from './tutor-llm.js';

afterEach(() => vi.unstubAllGlobals());

describe('Phase 33: the free AI quota in the app', () => {
  const resetsAt = '2026-10-11T07:00:00.000Z';

  it('reads a 503 quota_exhausted body, nothing else', () => {
    expect(quotaResetFrom(503, { error: 'quota_exhausted', resetsAt })?.toISOString()).toBe(resetsAt);
    expect(quotaResetFrom(503, { error: 'story_failed' })).toBeUndefined();
    expect(quotaResetFrom(429, { error: 'quota_exhausted', resetsAt })).toBeUndefined();
  });

  it('says it plainly, with the time in the profile zone', () => {
    expect(aiQuotaUsedUntil(new Date(resetsAt), new Date('2026-10-10T16:53:00Z'), 'America/New_York')).toBe(
      'The free AI quota is used up until about 3 am. Lessons, review and everything else still work.',
    );
  });

  it('a story request that meets quota_exhausted shows the message and pauses background stories', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'quota_exhausted', resetsAt: '2099-01-01T08:00:00.000Z' }), { status: 503 })),
    );
    const err = await new FetchTutorLLM('http://proxy.test')
      .writeStory({} as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyTurnError);
    expect((err as ProxyTurnError).resetsAt?.toISOString()).toBe('2099-01-01T08:00:00.000Z');
    expect(storyErrorText(err)).toMatch(/^The free AI quota is used up until about \d{1,2}(:\d\d)? (am|pm)\. Lessons, review and everything else still work\.$/);
    expect(aiErrorText(err)).toBe(storyErrorText(err));
    expect(aiPausedUntil(new Date('2098-12-31T00:00:00Z'))?.toISOString()).toBe('2099-01-01T08:00:00.000Z');
    expect(aiPausedUntil(new Date('2099-01-02T00:00:00Z'))).toBeUndefined();
  });
});
