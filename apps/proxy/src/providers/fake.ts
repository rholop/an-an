import type { TurnResponse } from '@anan/core';
import { ProviderRetryableError, type ProviderAdapter, type ProviderResult } from './types.js';

/** Test-only adapter — scripted behavior, no network. Used by orchestrator
 * and contract tests so "force a Gemini 429" doesn't require a real account. */
export class FakeProviderAdapter implements ProviderAdapter {
  calls = 0;

  constructor(
    public readonly name: 'gemini' | 'openai',
    private readonly behavior:
      | { kind: 'success'; response: TurnResponse }
      | { kind: 'error'; reason: 'rate_limit' | 'quota' | 'invalid_json'; message?: string }
      | { kind: 'throw'; error: Error },
  ) {}

  async generateTurn(_systemPrompt: string, _history: unknown[]): Promise<ProviderResult> {
    this.calls++;
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    if (this.behavior.kind === 'error') {
      throw new ProviderRetryableError(this.behavior.message ?? this.behavior.reason, this.behavior.reason);
    }
    return {
      response: this.behavior.response,
      provider: this.name,
      model: `fake-${this.name}`,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

export function fakeTurnResponse(overrides: Partial<TurnResponse> = {}): TurnResponse {
  return {
    reply_zh: '你好！',
    reply_en: 'Hello!',
    tokens: [{ text: '你好' }],
    targets_used: [],
    suggested_replies: [{ zh: '你好', en: 'Hello' }],
    goal_progress: [],
    ...overrides,
  };
}
