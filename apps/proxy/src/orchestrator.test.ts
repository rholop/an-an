import { describe, expect, it } from 'vitest';
import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import { buildEffectiveSystemPrompt, createOrchestrator } from './orchestrator.js';
import { fakeTurnResponse, FakeProviderAdapter } from './providers/fake.js';

const history: TurnHistoryEntry[] = [{ role: 'learner', zh: '我要一杯珍珠奶茶' }];

describe('createOrchestrator', () => {
  it('serves from Gemini (primary) on a normal success', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'success', response: fakeTurnResponse() });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    const orchestrator = createOrchestrator(gemini, openai, new PromptCache());

    const { log } = await orchestrator.run('system prompt', history);
    expect(log.provider).toBe('gemini');
    expect(log.cached).toBe(false);
    expect(log.fallbackReason).toBeUndefined();
    expect(gemini.calls).toBe(1);
    expect(openai.calls).toBe(0);
  });

  it('forcing a Gemini 429 makes the turn succeed via OpenAI (phase-3 acceptance criterion)', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'error', reason: 'rate_limit' });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    const orchestrator = createOrchestrator(gemini, openai, new PromptCache());

    const { result, log } = await orchestrator.run('system prompt', history);
    expect(log.provider).toBe('openai');
    expect(log.fallbackReason).toBe('rate_limit');
    expect(result.response.reply_zh).toBe('你好！');
    expect(gemini.calls).toBe(1);
    expect(openai.calls).toBe(1);
  });

  it('also falls back on Gemini quota exhaustion', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'error', reason: 'quota' });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    const { log } = await createOrchestrator(gemini, openai, new PromptCache()).run('p', history);
    expect(log.provider).toBe('openai');
    expect(log.fallbackReason).toBe('quota');
  });

  it('also falls back when Gemini returns invalid JSON', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'error', reason: 'invalid_json' });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    const { log } = await createOrchestrator(gemini, openai, new PromptCache()).run('p', history);
    expect(log.provider).toBe('openai');
    expect(log.fallbackReason).toBe('invalid_json');
  });

  it('does NOT fall back on a non-retryable error (propagates instead)', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'throw', error: new Error('network down') });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    await expect(createOrchestrator(gemini, openai, new PromptCache()).run('p', history)).rejects.toThrow(
      'network down',
    );
    expect(openai.calls).toBe(0);
  });

  it('propagates the error when BOTH providers fail', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'error', reason: 'rate_limit' });
    const openai = new FakeProviderAdapter('openai', { kind: 'error', reason: 'rate_limit' });
    await expect(createOrchestrator(gemini, openai, new PromptCache()).run('p', history)).rejects.toThrow();
  });

  it('caches a successful result, keyed by the full prompt, and serves the cache without calling either provider again', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'success', response: fakeTurnResponse() });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    const cache = new PromptCache();
    const orchestrator = createOrchestrator(gemini, openai, cache);

    await orchestrator.run('system prompt', history);
    const second = await orchestrator.run('system prompt', history);

    expect(second.log.cached).toBe(true);
    expect(gemini.calls).toBe(1); // not called again
  });

  it('does not share the cache across different prompts/history', async () => {
    const gemini = new FakeProviderAdapter('gemini', { kind: 'success', response: fakeTurnResponse() });
    const openai = new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse() });
    const cache = new PromptCache();
    const orchestrator = createOrchestrator(gemini, openai, cache);

    await orchestrator.run('system prompt A', history);
    const second = await orchestrator.run('system prompt B', history);

    expect(second.log.cached).toBe(false);
    expect(gemini.calls).toBe(2);
  });
});

describe('buildEffectiveSystemPrompt', () => {
  it('returns the prompt unchanged with no feedback', () => {
    expect(buildEffectiveSystemPrompt('base prompt')).toBe('base prompt');
  });

  it('appends feedback as a clearly-delimited addendum', () => {
    const result = buildEffectiveSystemPrompt('base prompt', 'avoid the word 哲學');
    expect(result).toContain('base prompt');
    expect(result).toContain('avoid the word 哲學');
  });
});
