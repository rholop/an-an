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
 * for: rate limit / quota exhaustion, any request error from the Gemini
 * adapter, or a response that wasn't valid JSON matching the schema. A plain
 * Error propagates and is NOT retried on the fallback provider. */
export class ProviderRetryableError extends Error {
  constructor(
    message: string,
    public readonly reason: ProviderFailureReason,
  ) {
    super(message);
    this.name = 'ProviderRetryableError';
  }
}

export type ProviderFailureReason =
  | 'rate_limit'
  | 'quota'
  | 'invalid_json'
  | 'request_error'
  | 'bad_request'
  | 'auth'
  | 'server_error'
  | 'not_configured';

/** Phase 25: every provider that was tried failed. The 502 body names each one and why (never a
 * key or a prompt). */
export class ProvidersFailedError extends Error {
  constructor(
    readonly providers: Array<{
      name: 'gemini' | 'openai';
      reason: ProviderFailureReason | 'error';
    }>,
    /** For the server log only (never sent to the browser). */
    causes: unknown[] = [],
  ) {
    super(
      `all providers failed: ${providers.map((p) => `${p.name} ${p.reason}`).join(', ')}${causes.length ? ` (${causes.map(String).join(' | ')})` : ''}`,
    );
    this.name = 'ProvidersFailedError';
  }
}

/** OpenAI's json_schema.name must match [a-zA-Z0-9_-]{1,64}: '/v1/story-check' → 'v1_story_check'. */
export function schemaName(task: string): string {
  const name = task
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return name || 'response';
}

export interface ProviderAdapter {
  readonly name: 'gemini' | 'openai';
  /** False for a placeholder with no API key; the orchestrator won't fall back to it. */
  readonly configured?: boolean;
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
  /** False for a placeholder with no API key; the orchestrator won't fall back to it. */
  readonly configured?: boolean;
  generateSentences(systemPrompt: string): Promise<SentenceProviderResult>;
}

/** Phase 5's journal endpoints (review, alternative-fix check, explain-more)
 * all share one shape — system prompt + user message in, schema-checked JSON
 * out — so they go through one generic method instead of one adapter method
 * per endpoint. */
export interface JsonTaskRequest<T> {
  /** Cache/log label, e.g. 'journal_review'. */
  task: string;
  systemPrompt: string;
  userMessage: string;
  /** Provider structured-output schema (see json-schema.ts). */
  jsonSchema: object;
  /** Zod-parses the raw JSON; a throw becomes ProviderRetryableError('invalid_json'). */
  parse: (raw: unknown) => T;
}

export interface JsonTaskResult<T> {
  response: T;
  provider: 'gemini' | 'openai';
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface JsonTaskAdapter {
  readonly name: 'gemini' | 'openai';
  /** False for a placeholder with no API key; the orchestrator won't fall back to it. */
  readonly configured?: boolean;
  generateJson<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>>;
}
