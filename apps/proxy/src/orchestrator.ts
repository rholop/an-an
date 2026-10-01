import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import { ProviderRetryableError, type ProviderAdapter, type ProviderResult } from './providers/types.js';

export interface OrchestratorLogEntry {
  provider: 'gemini' | 'openai';
  model: string;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number };
  fallbackReason?: string;
}

export interface Orchestrator {
  run(systemPrompt: string, history: TurnHistoryEntry[]): Promise<{ result: ProviderResult; log: OrchestratorLogEntry }>;
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
export function createOrchestrator(primary: ProviderAdapter, fallback: ProviderAdapter, cache: PromptCache): Orchestrator {
  return {
    async run(systemPrompt, history) {
      const historyJson = JSON.stringify(history);
      const cacheKey = PromptCache.keyFor(systemPrompt, historyJson);
      const cached = cache.get(cacheKey);
      if (cached) {
        return { result: cached, log: { provider: cached.provider, model: cached.model, cached: true, usage: cached.usage } };
      }

      try {
        const result = await primary.generateTurn(systemPrompt, history);
        cache.set(cacheKey, result);
        return { result, log: { provider: result.provider, model: result.model, cached: false, usage: result.usage } };
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
