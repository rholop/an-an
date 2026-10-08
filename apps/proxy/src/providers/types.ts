import type { SentenceGenResponse, TurnHistoryEntry, TurnResponse } from '@anan/core';

/**
 * Phase 25: the proxy talks to Gemini only (the owner's decision: free tier only). A "fallback" is
 * another Gemini model, and the independent checker is a fresh call on the checker model.
 */

type Usage = { inputTokens: number; outputTokens: number };

export interface ProviderResult {
  response: TurnResponse;
  /** The Gemini model that answered. */
  model: string;
  /** Token usage, for the daily-budget accounting and per-request logging. */
  usage: Usage;
}

export interface SentenceProviderResult {
  response: SentenceGenResponse;
  model: string;
  usage: Usage;
}

export type ProviderFailureReason =
  | 'rate_limited'
  | 'quota'
  | 'invalid_json'
  | 'timeout'
  | 'server_error'
  | 'request_error'
  | 'bad_request'
  | 'auth';

/** Reasons worth one more try on the same model after a short wait. */
export const RETRY_SAME_MODEL: ReadonlySet<ProviderFailureReason> = new Set([
  'rate_limited',
  'server_error',
  'timeout',
  'invalid_json',
]);

/** A failed model call the orchestrator may retry (same model, then the fallback model). An
 * `auth` error is never retried. A plain Error propagates and is not retried either. */
export class ProviderRetryableError extends Error {
  constructor(
    message: string,
    public readonly reason: ProviderFailureReason,
    /** From a 429's retry-after, when Gemini sends one. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderRetryableError';
  }
}

export interface ModelAttempt {
  model: string;
  reason: ProviderFailureReason | 'error';
}

/** Every model that was tried failed. The 502 body names each one and why (never a key or a prompt). */
export class ModelsFailedError extends Error {
  constructor(
    readonly attempts: ModelAttempt[],
    /** For the server log only (never sent to the browser). */
    causes: unknown[] = [],
  ) {
    super(
      `all models failed: ${attempts.map((a) => `${a.model} ${a.reason}`).join(', ')}${causes.length ? ` (${causes.map(String).join(' | ')})` : ''}`,
    );
    this.name = 'ModelsFailedError';
  }
}

export interface ProviderAdapter {
  readonly model: string;
  /** `systemPrompt` already has any regeneration feedback folded in (see
   * orchestrator.ts's buildEffectiveSystemPrompt) — adapters don't need to
   * know about the regeneration loop at all. */
  generateTurn(systemPrompt: string, history: TurnHistoryEntry[]): Promise<ProviderResult>;
}

/** A separate, narrower interface rather than folding into ProviderAdapter
 * (different response shape, no chat history). GeminiAdapter implements both. */
export interface SentenceGenAdapter {
  readonly model: string;
  generateSentences(systemPrompt: string): Promise<SentenceProviderResult>;
}

/** Phase 5's journal endpoints (review, alternative-fix check, explain-more)
 * all share one shape — system prompt + user message in, schema-checked JSON
 * out — so they go through one generic method instead of one adapter method
 * per endpoint. */
export interface JsonTaskRequest<T> {
  /** Cache/log label, e.g. '/v1/journal-review'. */
  task: string;
  systemPrompt: string;
  userMessage: string;
  /** Gemini responseSchema (see json-schema.ts), with the zod limits written in. */
  jsonSchema: object;
  /** Zod-parses the raw JSON; a throw becomes ProviderRetryableError('invalid_json'). */
  parse: (raw: unknown) => T;
}

export interface JsonTaskResult<T> {
  response: T;
  model: string;
  usage: Usage;
}

export interface JsonTaskAdapter {
  readonly model: string;
  generateJson<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>>;
}
