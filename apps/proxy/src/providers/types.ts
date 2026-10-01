import type { SentenceGenResponse, TurnHistoryEntry, TurnResponse } from '@anan/core';

export interface ProviderResult {
  response: TurnResponse;
  provider: 'gemini' | 'openai';
  model: string;
  /** Token usage, for the daily-budget accounting and per-request logging. */
  usage: { inputTokens: number; outputTokens: number };
}

export interface SentenceProviderResult {
  response: SentenceGenResponse;
  provider: 'gemini' | 'openai';
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Thrown for a condition the orchestrator should retry-on-the-other-provider
 * for: rate limit / quota exhaustion, or a response that wasn't valid JSON
 * matching TurnResponseSchema. Anything else (network error, auth error)
 * propagates as a plain Error and is NOT retried on the fallback provider —
 * only the specific failure modes CLAUDE.md names get the fallback. */
export class ProviderRetryableError extends Error {
  constructor(
    message: string,
    public readonly reason: 'rate_limit' | 'quota' | 'invalid_json',
  ) {
    super(message);
    this.name = 'ProviderRetryableError';
  }
}

export interface ProviderAdapter {
  readonly name: 'gemini' | 'openai';
  /** `systemPrompt` already has any regeneration feedback folded in (see
   * orchestrator.ts's buildEffectiveSystemPrompt) — adapters don't need to
   * know about the regeneration loop at all. */
  generateTurn(systemPrompt: string, history: TurnHistoryEntry[]): Promise<ProviderResult>;
}

/** A separate, narrower interface rather than folding into ProviderAdapter
 * (different response shape, no chat history) — GeminiAdapter/OpenAiAdapter
 * implement both, reusing the same client/API key setup. */
export interface SentenceGenAdapter {
  readonly name: 'gemini' | 'openai';
  generateSentences(systemPrompt: string): Promise<SentenceProviderResult>;
}
