import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import {
  ProviderRetryableError,
  ProvidersFailedError,
  type JsonTaskAdapter,
  type JsonTaskRequest,
  type JsonTaskResult,
  type ProviderAdapter,
  type ProviderResult,
  type SentenceGenAdapter,
  type SentenceProviderResult,
} from './providers/types.js';

export interface OrchestratorLogEntry {
  provider: 'gemini' | 'openai';
  model: string;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number };
  fallbackReason?: string;
}

export type AttemptLogger = (entry: Record<string, unknown>) => void;

const defaultAttemptLogger: AttemptLogger = (entry) => console.log(JSON.stringify(entry));

interface Served {
  provider: 'gemini' | 'openai';
  model: string;
}

/**
 * Tries `primary`, then `fallback` on a ProviderRetryableError — unless the
 * fallback has no API key, in which case the primary's error is rethrown
 * rather than masked by "openai is not configured". Logs every provider tried.
 */
async function withFallback<
  A extends { name: 'gemini' | 'openai'; configured?: boolean },
  R extends Served,
>(
  primary: A,
  fallback: A,
  call: (adapter: A) => Promise<R>,
  logAttempt: AttemptLogger,
): Promise<{ result: R; fallbackReason?: string }> {
  const reasonOf = (e: unknown) =>
    e instanceof ProviderRetryableError ? e.reason : ('error' as const);
  try {
    const result = await call(primary);
    logAttempt({ event: 'provider_attempt', provider: primary.name, ok: true });
    return { result };
  } catch (err) {
    logAttempt({
      event: 'provider_attempt',
      provider: primary.name,
      ok: false,
      error: String(err),
    });
    if (!(err instanceof ProviderRetryableError))
      throw new ProvidersFailedError([{ name: primary.name, reason: 'error' }], [err]);
    if (fallback.configured === false || fallback === primary) {
      logAttempt({ event: 'provider_skipped', provider: fallback.name, reason: 'not configured' });
      throw new ProvidersFailedError(
        [
          { name: primary.name, reason: err.reason },
          ...(fallback === primary
            ? []
            : [{ name: fallback.name, reason: 'not_configured' as const }]),
        ],
        [err],
      );
    }
    try {
      const result = await call(fallback);
      logAttempt({
        event: 'provider_attempt',
        provider: fallback.name,
        ok: true,
        fallbackFor: primary.name,
      });
      return { result, fallbackReason: err.reason };
    } catch (fallbackErr) {
      logAttempt({
        event: 'provider_attempt',
        provider: fallback.name,
        ok: false,
        fallbackFor: primary.name,
        error: String(fallbackErr),
      });
      throw new ProvidersFailedError(
        [
          { name: primary.name, reason: err.reason },
          { name: fallback.name, reason: reasonOf(fallbackErr) },
        ],
        [err, fallbackErr],
      );
    }
  }
}

function servedLog(
  r: Served & { usage: OrchestratorLogEntry['usage'] },
  fallbackReason?: string,
): OrchestratorLogEntry {
  return {
    provider: r.provider,
    model: r.model,
    cached: false,
    usage: r.usage,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

export interface Orchestrator {
  run(
    systemPrompt: string,
    history: TurnHistoryEntry[],
    /** Phase 21: start with the fallback provider (a retry after repeated Taiwan-check failures). */
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
 * Gemini first; on rate limit, quota exhaustion, any Gemini request error,
 * or invalid JSON, retry once on OpenAI (CLAUDE.md §1). Logs which provider actually served each
 * request. Caches successful results keyed by the full prompt hash.
 */
export function createOrchestrator(
  primary: ProviderAdapter,
  fallback: ProviderAdapter,
  cache: PromptCache,
  logAttempt: AttemptLogger = defaultAttemptLogger,
): Orchestrator {
  return {
    async run(systemPrompt, history, opts) {
      const historyJson = JSON.stringify(history);
      const alternate = opts?.alternate === true && fallback.configured !== false;
      const cacheKey = PromptCache.keyFor(
        alternate ? `alt\n${systemPrompt}` : systemPrompt,
        historyJson,
      );
      const cached = cache.get(cacheKey);
      if (cached) {
        return {
          result: cached,
          log: {
            provider: cached.provider,
            model: cached.model,
            cached: true,
            usage: cached.usage,
          },
        };
      }

      const { result, fallbackReason } = await withFallback(
        alternate ? fallback : primary,
        alternate ? primary : fallback,
        (adapter) => adapter.generateTurn(systemPrompt, history),
        logAttempt,
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}

export interface SentenceOrchestrator {
  run(systemPrompt: string): Promise<{ result: SentenceProviderResult; log: OrchestratorLogEntry }>;
}

/**
 * Same Gemini-first/OpenAI-fallback/cache shape as createOrchestrator, for
 * POST /v1/sentences — kept as its own small function rather than
 * generalizing createOrchestrator over a type parameter: the two "run"
 * shapes differ (prompt+history vs. prompt-only, which changes the cache
 * key), and duplicating this ~15-line control flow is simpler than a
 * generic abstraction two call sites don't otherwise need.
 */
export function createSentenceOrchestrator(
  primary: SentenceGenAdapter,
  fallback: SentenceGenAdapter,
  cache: PromptCache<SentenceProviderResult>,
  logAttempt: AttemptLogger = defaultAttemptLogger,
): SentenceOrchestrator {
  return {
    async run(systemPrompt) {
      const cacheKey = PromptCache.keyForPrompt(systemPrompt);
      const cached = cache.get(cacheKey);
      if (cached) {
        return {
          result: cached,
          log: {
            provider: cached.provider,
            model: cached.model,
            cached: true,
            usage: cached.usage,
          },
        };
      }

      const { result, fallbackReason } = await withFallback(
        primary,
        fallback,
        (adapter) => adapter.generateSentences(systemPrompt),
        logAttempt,
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}

export interface JsonRunOptions {
  /** Phase 17: use the other provider when it is configured, so one model's
   * mistake isn't approved by itself (the checker avoids the corrector). */
  avoidProvider?: 'gemini' | 'openai';
}

export interface JsonOrchestrator {
  run<T>(
    req: JsonTaskRequest<T>,
    opts?: JsonRunOptions,
  ): Promise<{ result: JsonTaskResult<T>; log: OrchestratorLogEntry }>;
}

/**
 * Same Gemini-first / OpenAI-fallback / cache control flow, for the Phase 5
 * journal tasks. The cache is keyed by task + system prompt + user message,
 * so an identical review/check/explain request (a re-submitted entry, the
 * same alternative-fix check) never costs a second model call.
 */
export function createJsonOrchestrator(
  primary: JsonTaskAdapter,
  fallback: JsonTaskAdapter,
  cache: PromptCache<JsonTaskResult<unknown>>,
  logAttempt: AttemptLogger = defaultAttemptLogger,
): JsonOrchestrator {
  return {
    async run<T>(req: JsonTaskRequest<T>, opts: JsonRunOptions = {}) {
      // Swap the order when asked to avoid the usual first choice — but only
      // if the other one can actually answer.
      const swap =
        opts.avoidProvider === primary.name &&
        fallback.configured !== false &&
        fallback !== primary;
      const [first, second] = swap ? [fallback, primary] : [primary, fallback];
      const cacheKey = PromptCache.keyFor(
        `${req.task}\n${swap ? 'swap\n' : ''}${req.systemPrompt}`,
        req.userMessage,
      );
      const cached = cache.get(cacheKey);
      if (cached) {
        return {
          result: cached as JsonTaskResult<T>,
          log: {
            provider: cached.provider,
            model: cached.model,
            cached: true,
            usage: cached.usage,
          },
        };
      }

      const { result, fallbackReason } = await withFallback(
        first,
        second,
        (adapter) => adapter.generateJson(req),
        logAttempt,
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}
