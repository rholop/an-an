import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import {
  ProviderRetryableError,
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

export interface Orchestrator {
  run(
    systemPrompt: string,
    history: TurnHistoryEntry[],
  ): Promise<{ result: ProviderResult; log: OrchestratorLogEntry }>;
}

/** Folds regeneration feedback into the system prompt — adapters never see
 * the regeneration loop, they just get a slightly longer system prompt. */
export function buildEffectiveSystemPrompt(systemPrompt: string, feedback?: string): string {
  if (!feedback) return systemPrompt;
  return `${systemPrompt}\n\n## Your previous reply needs a redo\n${feedback}`;
}

/**
 * Gemini first; on rate limit, quota exhaustion, or invalid JSON, retry
 * once on OpenAI (CLAUDE.md §1). Logs which provider actually served each
 * request. Caches successful results keyed by the full prompt hash.
 */
export function createOrchestrator(
  primary: ProviderAdapter,
  fallback: ProviderAdapter,
  cache: PromptCache,
): Orchestrator {
  return {
    async run(systemPrompt, history) {
      const historyJson = JSON.stringify(history);
      const cacheKey = PromptCache.keyFor(systemPrompt, historyJson);
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

      try {
        const result = await primary.generateTurn(systemPrompt, history);
        cache.set(cacheKey, result);
        return {
          result,
          log: {
            provider: result.provider,
            model: result.model,
            cached: false,
            usage: result.usage,
          },
        };
      } catch (err) {
        if (!(err instanceof ProviderRetryableError)) throw err;

        const result = await fallback.generateTurn(systemPrompt, history);
        cache.set(cacheKey, result);
        return {
          result,
          log: {
            provider: result.provider,
            model: result.model,
            cached: false,
            usage: result.usage,
            fallbackReason: err.reason,
          },
        };
      }
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

      try {
        const result = await primary.generateSentences(systemPrompt);
        cache.set(cacheKey, result);
        return {
          result,
          log: {
            provider: result.provider,
            model: result.model,
            cached: false,
            usage: result.usage,
          },
        };
      } catch (err) {
        if (!(err instanceof ProviderRetryableError)) throw err;

        const result = await fallback.generateSentences(systemPrompt);
        cache.set(cacheKey, result);
        return {
          result,
          log: {
            provider: result.provider,
            model: result.model,
            cached: false,
            usage: result.usage,
            fallbackReason: err.reason,
          },
        };
      }
    },
  };
}

export interface JsonOrchestrator {
  run<T>(
    req: JsonTaskRequest<T>,
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
): JsonOrchestrator {
  return {
    async run<T>(req: JsonTaskRequest<T>) {
      const cacheKey = PromptCache.keyFor(`${req.task}\n${req.systemPrompt}`, req.userMessage);
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

      try {
        const result = await primary.generateJson(req);
        cache.set(cacheKey, result);
        return {
          result,
          log: {
            provider: result.provider,
            model: result.model,
            cached: false,
            usage: result.usage,
          },
        };
      } catch (err) {
        if (!(err instanceof ProviderRetryableError)) throw err;
        const result = await fallback.generateJson(req);
        cache.set(cacheKey, result);
        return {
          result,
          log: {
            provider: result.provider,
            model: result.model,
            cached: false,
            usage: result.usage,
            fallbackReason: err.reason,
          },
        };
      }
    },
  };
}
