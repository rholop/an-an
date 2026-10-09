import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import {
  ModelsFailedError,
  ProviderRetryableError,
  RETRY_SAME_MODEL,
  type ModelAttempt,
  type JsonTaskAdapter,
  type JsonTaskRequest,
  type JsonTaskResult,
  type ProviderAdapter,
  type ProviderResult,
  type SentenceGenAdapter,
  type SentenceProviderResult,
} from './providers/types.js';

export interface OrchestratorLogEntry {
  /** The Gemini model that answered. */
  model: string;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number };
  /** Why the first model did not answer, when another try did. */
  fallbackReason?: string;
}

export type AttemptLogger = (entry: Record<string, unknown>) => void;

const defaultAttemptLogger: AttemptLogger = (entry) => console.log(JSON.stringify(entry));

/** Waits, for the retry backoff (tests pass an instant one). */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RetryPolicy {
  /** Backoff before the same-model retry. */
  backoffMs: number;
  /** A 429's retry-after longer than this is not waited for: go to the fallback model. */
  maxWaitMs: number;
  /** No new try starts this long after the first one (nginx gives up on a request after 60 s). */
  deadlineMs?: number;
  sleep: Sleep;
  now?: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = { backoffMs: 1_000, maxWaitMs: 8_000, deadlineMs: 35_000, sleep: realSleep };

interface Served {
  model: string;
}

/**
 * Phase 25 (Gemini only): try `primary`; on a retryable error (429, 5xx, timeout, invalid JSON)
 * wait and try it once more (honouring a short retry-after); then try `fallback`, a different
 * Gemini model, once. Authentication errors and plain errors are never retried. Logs every try.
 */
async function withRetries<A extends { model: string }, R extends Served>(
  primary: A,
  fallback: A | undefined,
  call: (adapter: A) => Promise<R>,
  logAttempt: AttemptLogger,
  policy: RetryPolicy,
): Promise<{ result: R; fallbackReason?: string }> {
  const attempts: ModelAttempt[] = [];
  const causes: unknown[] = [];
  const tryOnce = async (adapter: A, note: string): Promise<R | undefined> => {
    try {
      const result = await call(adapter);
      logAttempt({ event: 'model_attempt', model: adapter.model, ok: true, try: note });
      return result;
    } catch (err) {
      logAttempt({ event: 'model_attempt', model: adapter.model, ok: false, try: note, error: String(err) });
      attempts.push({ model: adapter.model, reason: err instanceof ProviderRetryableError ? err.reason : 'error' });
      causes.push(err);
      return undefined;
    }
  };
  const lastErr = () => causes[causes.length - 1];
  const stop = () => {
    const e = lastErr();
    return !(e instanceof ProviderRetryableError) || e.reason === 'auth';
  };

  const now = policy.now ?? Date.now;
  const started = now();
  const inTime = (extraWait = 0) => policy.deadlineMs === undefined || now() + extraWait - started < policy.deadlineMs;
  const first = await tryOnce(primary, 'first');
  if (first) return { result: first };
  if (stop()) throw new ModelsFailedError(attempts, causes);

  const err = lastErr() as ProviderRetryableError;
  if (RETRY_SAME_MODEL.has(err.reason)) {
    const wait = err.retryAfterMs ?? policy.backoffMs;
    if (wait <= policy.maxWaitMs && inTime(wait)) {
      await policy.sleep(wait);
      const again = await tryOnce(primary, 'retry');
      if (again) return { result: again, fallbackReason: err.reason };
      if (stop()) throw new ModelsFailedError(attempts, causes);
    }
  }
  if (fallback && fallback.model !== primary.model && inTime()) {
    const fb = await tryOnce(fallback, 'fallback');
    if (fb) return { result: fb, fallbackReason: err.reason };
  }
  throw new ModelsFailedError(attempts, causes);
}

function servedLog(
  r: Served & { usage: OrchestratorLogEntry['usage'] },
  fallbackReason?: string,
): OrchestratorLogEntry {
  return {
    model: r.model,
    cached: false,
    usage: r.usage,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

const cachedLog = (r: Served & { usage: OrchestratorLogEntry['usage'] }): OrchestratorLogEntry => ({
  model: r.model,
  cached: true,
  usage: r.usage,
});

export interface Orchestrator {
  run(
    systemPrompt: string,
    history: TurnHistoryEntry[],
    /** Phase 21/25: start with the fallback model (a retry after repeated Taiwan-check failures). */
    opts?: { alternate?: boolean },
  ): Promise<{ result: ProviderResult; log: OrchestratorLogEntry }>;
}

/** Folds regeneration feedback into the system prompt — adapters never see
 * the regeneration loop, they just get a slightly longer system prompt. */
export function buildEffectiveSystemPrompt(systemPrompt: string, feedback?: string): string {
  if (!feedback) return systemPrompt;
  return `${systemPrompt}\n\n## Your previous reply needs a redo\n${feedback}`;
}

/**
 * The task's Gemini model first, retried once, then the fallback Gemini model (see withRetries).
 * Caches successful results keyed by the full prompt hash.
 */
export function createOrchestrator(
  primary: ProviderAdapter,
  fallback: ProviderAdapter | undefined,
  cache: PromptCache,
  logAttempt: AttemptLogger = defaultAttemptLogger,
  policy: RetryPolicy = DEFAULT_RETRY,
): Orchestrator {
  return {
    async run(systemPrompt, history, opts) {
      const historyJson = JSON.stringify(history);
      const alternate = opts?.alternate === true && fallback !== undefined;
      const cacheKey = PromptCache.keyFor(alternate ? `alt\n${systemPrompt}` : systemPrompt, historyJson);
      const cached = cache.get(cacheKey);
      if (cached) return { result: cached, log: cachedLog(cached) };

      const { result, fallbackReason } = await withRetries(
        alternate ? fallback! : primary,
        alternate ? primary : fallback,
        (adapter) => adapter.generateTurn(systemPrompt, history),
        logAttempt,
        policy,
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}

export interface SentenceOrchestrator {
  run(systemPrompt: string): Promise<{ result: SentenceProviderResult; log: OrchestratorLogEntry }>;
}

/** The same retry / fallback / cache flow, for POST /v1/sentences. */
export function createSentenceOrchestrator(
  primary: SentenceGenAdapter,
  fallback: SentenceGenAdapter | undefined,
  cache: PromptCache<SentenceProviderResult>,
  logAttempt: AttemptLogger = defaultAttemptLogger,
  policy: RetryPolicy = DEFAULT_RETRY,
): SentenceOrchestrator {
  return {
    async run(systemPrompt) {
      const cacheKey = PromptCache.keyForPrompt(systemPrompt);
      const cached = cache.get(cacheKey);
      if (cached) return { result: cached, log: cachedLog(cached) };
      const { result, fallbackReason } = await withRetries(
        primary,
        fallback,
        (adapter) => adapter.generateSentences(systemPrompt),
        logAttempt,
        policy,
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}

export interface JsonRunOptions {
  /** Phase 25: the independent check (Phases 17 and 24). A fresh call on the checker model, which
   * never sees the writer's prompt, history or reasoning (the route builds its own prompt). */
  checker?: boolean;
  /** Phase 26: a regeneration or repair: never answered from the cache (the answer is still stored). */
  noCache?: boolean;
}

export interface JsonOrchestrator {
  run<T>(
    req: JsonTaskRequest<T>,
    opts?: JsonRunOptions,
  ): Promise<{ result: JsonTaskResult<T>; log: OrchestratorLogEntry }>;
}

/**
 * The same flow for the JSON tasks (journal, gloss, stories…). The cache is keyed by task + system
 * prompt + user message, so an identical request never costs a second model call. With
 * `{ checker: true }` the checker model answers first (then the fallback model).
 */
export function createJsonOrchestrator(
  primary: JsonTaskAdapter,
  fallback: JsonTaskAdapter | undefined,
  cache: PromptCache<JsonTaskResult<unknown>>,
  logAttempt: AttemptLogger = defaultAttemptLogger,
  opts: { checker?: JsonTaskAdapter; policy?: RetryPolicy } = {},
): JsonOrchestrator {
  const policy = opts.policy ?? DEFAULT_RETRY;
  return {
    async run<T>(req: JsonTaskRequest<T>, runOpts: JsonRunOptions = {}) {
      const first = runOpts.checker && opts.checker ? opts.checker : primary;
      const cacheKey = PromptCache.keyFor(
        `${req.task}\n${first === primary ? '' : `checker:${first.model}\n`}${req.systemPrompt}`,
        req.userMessage,
      );
      const cached = runOpts.noCache ? undefined : cache.get(cacheKey);
      if (cached) return { result: cached as JsonTaskResult<T>, log: cachedLog(cached) };

      const second = first === primary ? fallback : fallback && fallback.model !== first.model ? fallback : primary;
      const { result, fallbackReason } = await withRetries(
        first,
        second,
        (adapter) => adapter.generateJson(req),
        logAttempt,
        policy,
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}
