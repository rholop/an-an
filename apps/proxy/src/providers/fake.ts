import type { SentenceGenResponse, TurnResponse } from '@anan/core';
import {
  ProviderRetryableError,
  type ProviderAdapter,
  type JsonTaskAdapter,
  type JsonTaskRequest,
  type JsonTaskResult,
  type ProviderResult,
  type SentenceGenAdapter,
  type SentenceProviderResult,
  type ProviderFailureReason,
} from './types.js';

/** Test-only adapter — scripted behavior, no network. Used by orchestrator
 * and contract tests so "force a Gemini 429" doesn't require a real account. */
export class FakeProviderAdapter implements ProviderAdapter {
  calls = 0;

  constructor(
    public readonly model: string,
    private readonly behavior:
      | { kind: 'success'; response: TurnResponse }
      | {
          kind: 'error';
          reason: ProviderFailureReason;
          message?: string;
        }
      | { kind: 'throw'; error: Error },
  ) {}

  async generateTurn(_systemPrompt: string, _history: unknown[]): Promise<ProviderResult> {
    this.calls++;
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    if (this.behavior.kind === 'error') {
      throw new ProviderRetryableError(
        this.behavior.message ?? this.behavior.reason,
        this.behavior.reason,
      );
    }
    return {
      response: this.behavior.response,
      model: this.model,
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

/** Same scripted-behavior shape as FakeProviderAdapter, for /v1/sentences'
 * orchestrator tests — a separate class since SentenceGenAdapter is a
 * separate interface (see providers/types.ts). */
export class FakeSentenceGenAdapter implements SentenceGenAdapter {
  calls = 0;

  constructor(
    public readonly model: string,
    private readonly behavior:
      | { kind: 'success'; response: SentenceGenResponse }
      | {
          kind: 'error';
          reason: ProviderFailureReason;
          message?: string;
        }
      | { kind: 'throw'; error: Error },
  ) {}

  async generateSentences(_systemPrompt: string): Promise<SentenceProviderResult> {
    this.calls++;
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    if (this.behavior.kind === 'error') {
      throw new ProviderRetryableError(
        this.behavior.message ?? this.behavior.reason,
        this.behavior.reason,
      );
    }
    return {
      response: this.behavior.response,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

export function fakeSentenceGenResponse(
  overrides: Partial<SentenceGenResponse> = {},
): SentenceGenResponse {
  return {
    sentences: [
      {
        zh: '我喜歡喝珍珠奶茶。',
        en: 'I like to drink bubble tea.',
        tokens: [{ text: '我' }, { text: '喜歡' }],
      },
    ],
    ...overrides,
  };
}

/** Scripted JsonTaskAdapter: returns `respond(req)` (already-parsed data),
 * after running the request's own `parse` so schema drift in a test fixture
 * fails the same way a bad provider response would. */
export class FakeJsonAdapter implements JsonTaskAdapter {
  calls = 0;

  constructor(
    public readonly model: string,
    private readonly behavior:
      | { kind: 'success'; respond: (req: JsonTaskRequest<unknown>) => unknown }
      | { kind: 'error'; reason: ProviderFailureReason }
      | { kind: 'throw'; error: Error },
  ) {}

  async generateJson<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>> {
    this.calls++;
    if (this.behavior.kind === 'throw') throw this.behavior.error;
    if (this.behavior.kind === 'error')
      throw new ProviderRetryableError(this.behavior.reason, this.behavior.reason);
    let response: T;
    try {
      response = req.parse(this.behavior.respond(req as JsonTaskRequest<unknown>));
    } catch (err) {
      throw new ProviderRetryableError(String(err), 'invalid_json');
    }
    return {
      response,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}
