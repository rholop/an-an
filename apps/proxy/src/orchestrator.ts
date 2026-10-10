import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import type { AiPriority, QuotaTracker } from './quota.js';
import {
  ModelsFailedError,
  QuotaExhaustedError,
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

/** Phase 33: who is asking. Batch requests (scripts, `x-ai-priority: batch`) leave each model's
 * reserve for the live app. */
export interface ChainRun {
  quota?: QuotaTracker;
  priority?: AiPriority;
}

const QUOTA_SKIPS = new Set<ModelAttempt['reason']>(['exhausted', 'reserved', 'quota', 'not_found']);

/** One model per name, in order. */
function uniqueChain<A extends { model: string }>(chain: readonly (A | undefined)[]): A[] {
  const seen = new Set<string>();
  return chain.filter((a): a is A => a !== undefined && !seen.has(a.model) && (seen.add(a.model), true));
}

/**
 * Phase 33 (Phase 25's retry rule, along a chain of Gemini models): models out of free quota are
 * skipped with no call. The first model tried gets one more try after a retryable error (429 per
 * minute, 5xx, timeout, invalid JSON), honouring a short retry-after; then each next model is
 * tried once. A per-day quota 429 marks that model out until its reset and moves on at once.
 * Authentication errors and plain errors stop the chain. When every model is out of quota the
 * error is a QuotaExhaustedError (503 quota_exhausted with resetsAt). Logs every try.
 */
async function withRetries<A extends { model: string }, R extends Served>(
  chainIn: readonly (A | undefined)[],
  call: (adapter: A) => Promise<R>,
  logAttempt: AttemptLogger,
  policy: RetryPolicy,
  run: ChainRun = {},
): Promise<{ result: R; fallbackReason?: string }> {
  const chain = uniqueChain(chainIn);
  const { quota } = run;
  const priority = run.priority ?? 'live';
  const attempts: ModelAttempt[] = [];
  const causes: unknown[] = [];
  const tryOnce = async (adapter: A, note: string): Promise<R | undefined> => {
    try {
      const result = await call(adapter);
      quota?.recordCall(adapter.model);
      logAttempt({ event: 'model_attempt', model: adapter.model, ok: true, try: note, ...(priority === 'batch' ? { priority } : {}) });
      return result;
    } catch (err) {
      logAttempt({ event: 'model_attempt', model: adapter.model, ok: false, try: note, error: String(err) });
      const reason = err instanceof ProviderRetryableError ? err.reason : 'error';
      attempts.push({ model: adapter.model, reason });
      causes.push(err);
      if (err instanceof ProviderRetryableError) {
        if (err.reason === 'quota') quota?.markExhausted(adapter.model, { retryAfterMs: err.retryAfterMs, limit: err.quotaLimit });
        else if (err.reason === 'not_found') quota?.markExhausted(adapter.model);
        // a call that reached the model counts toward its daily requests
        else if (err.reason !== 'rate_limited' && err.reason !== 'auth') quota?.recordCall(adapter.model);
      } else quota?.recordCall(adapter.model);
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
  let firstReason: string | undefined;
  let tried = 0;

  for (const adapter of chain) {
    const blocked = quota?.blocked(adapter.model, priority);
    if (blocked) {
      attempts.push({ model: adapter.model, reason: blocked });
      logAttempt({ event: 'model_skipped', model: adapter.model, why: blocked });
      continue;
    }
    if (tried > 0 && !inTime()) break;
    const first = tried === 0;
    tried++;
    const got = await tryOnce(adapter, first ? 'first' : 'fallback');
    if (got) return { result: got, ...(firstReason ? { fallbackReason: firstReason } : {}) };
    if (stop()) throw new ModelsFailedError(attempts, causes);
    const err = lastErr() as ProviderRetryableError;
    firstReason ??= err.reason;
    if (first && RETRY_SAME_MODEL.has(err.reason)) {
      const wait = err.retryAfterMs ?? policy.backoffMs;
      if (wait <= policy.maxWaitMs && inTime(wait)) {
        await policy.sleep(wait);
        const again = await tryOnce(adapter, 'retry');
        if (again) return { result: again, fallbackReason: err.reason };
        if (stop()) throw new ModelsFailedError(attempts, causes);
      }
    }
  }
  if (quota && attempts.length > 0 && attempts.every((a) => QUOTA_SKIPS.has(a.reason))) {
    const reserved = attempts.some((a) => a.reason === 'reserved');
    throw new QuotaExhaustedError(quota.resetsAt(chain.map((a) => a.model), priority), attempts, reserved);
  }
  throw new ModelsFailedError(attempts, causes);
}

/** A chain from either one adapter or a list, then the fallback model last. */
function asChain<A>(primary: A | readonly A[], fallback?: A): A[] {
  return [...(Array.isArray(primary) ? (primary as readonly A[]) : [primary as A]), ...(fallback ? [fallback] : [])];
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
    /** Phase 21/25: start with the next model of the chain (a retry after repeated Taiwan-check
     * failures). Phase 33: `priority` and `model` (a script's `--model`) as for JSON tasks. */
    opts?: { alternate?: boolean } & RunPriority,
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
  primary: ProviderAdapter | readonly ProviderAdapter[],
  fallback: ProviderAdapter | undefined,
  cache: PromptCache,
  logAttempt: AttemptLogger = defaultAttemptLogger,
  policy: RetryPolicy = DEFAULT_RETRY,
  quota?: QuotaTracker,
): Orchestrator {
  const chain = uniqueChain(asChain(primary, fallback));
  return {
    async run(systemPrompt, history, opts) {
      const historyJson = JSON.stringify(history);
      const alternate = opts?.alternate === true && chain.length > 1;
      const cacheKey = PromptCache.keyFor(alternate ? `alt\n${systemPrompt}` : systemPrompt, historyJson);
      const cached = cache.get(cacheKey);
      if (cached) return { result: cached, log: cachedLog(cached) };

      const order = alternate ? [...chain.slice(1), chain[0]!] : chain;
      const { result, fallbackReason } = await withRetries(
        onlyModel(order, opts?.model),
        (adapter) => adapter.generateTurn(systemPrompt, history),
        logAttempt,
        policy,
        { quota, priority: opts?.priority },
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}

export interface SentenceOrchestrator {
  run(systemPrompt: string, opts?: RunPriority): Promise<{ result: SentenceProviderResult; log: OrchestratorLogEntry }>;
}

/** The same retry / fallback / cache flow, for POST /v1/sentences. */
export function createSentenceOrchestrator(
  primary: SentenceGenAdapter | readonly SentenceGenAdapter[],
  fallback: SentenceGenAdapter | undefined,
  cache: PromptCache<SentenceProviderResult>,
  logAttempt: AttemptLogger = defaultAttemptLogger,
  policy: RetryPolicy = DEFAULT_RETRY,
  quota?: QuotaTracker,
): SentenceOrchestrator {
  const chain = uniqueChain(asChain(primary, fallback));
  return {
    async run(systemPrompt, opts) {
      const cacheKey = PromptCache.keyForPrompt(systemPrompt);
      const cached = cache.get(cacheKey);
      if (cached) return { result: cached, log: cachedLog(cached) };
      const { result, fallbackReason } = await withRetries(
        onlyModel(chain, opts?.model),
        (adapter) => adapter.generateSentences(systemPrompt),
        logAttempt,
        policy,
        { quota, priority: opts?.priority },
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}

/** Phase 33: batch requests (scripts) leave the live reserve; `model` narrows the chain to one
 * model (a script's `--model`). */
export interface RunPriority {
  priority?: AiPriority;
  model?: string;
}

/** The chain narrowed to `model` when one is asked for. */
function onlyModel<A extends { model: string }>(chain: readonly A[], model: string | undefined): A[] {
  return model ? chain.filter((a) => a.model === model) : [...chain];
}

export interface JsonRunOptions extends RunPriority {
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
 * `{ checker: true }` the checker chain answers (then the fallback model). Phase 33: the checker
 * prefers a model other than the one the writer chain would use now, but uses it when nothing else
 * has quota.
 */
export function createJsonOrchestrator(
  primary: JsonTaskAdapter | readonly JsonTaskAdapter[],
  fallback: JsonTaskAdapter | undefined,
  cache: PromptCache<JsonTaskResult<unknown>>,
  logAttempt: AttemptLogger = defaultAttemptLogger,
  opts: { checker?: JsonTaskAdapter | readonly JsonTaskAdapter[]; policy?: RetryPolicy; quota?: QuotaTracker } = {},
): JsonOrchestrator {
  const policy = opts.policy ?? DEFAULT_RETRY;
  const { quota } = opts;
  const writer = uniqueChain(asChain(primary, fallback));
  const checker = opts.checker ? uniqueChain(asChain(opts.checker, fallback)) : undefined;
  const all = uniqueChain([...writer, ...(checker ?? [])]);
  return {
    async run<T>(req: JsonTaskRequest<T>, runOpts: JsonRunOptions = {}) {
      const asChecker = runOpts.checker === true && checker !== undefined;
      const cacheKey = PromptCache.keyFor(
        `${req.task}\n${asChecker ? 'checker\n' : ''}${runOpts.model ? `model:${runOpts.model}\n` : ''}${req.systemPrompt}`,
        req.userMessage,
      );
      const cached = runOpts.noCache ? undefined : cache.get(cacheKey);
      if (cached) return { result: cached as JsonTaskResult<T>, log: cachedLog(cached) };

      let chain: JsonTaskAdapter[];
      if (runOpts.model) chain = onlyModel(all, runOpts.model);
      else if (asChecker) {
        // the model the writer would answer with now goes last
        const writerNow = writer.find((a) => !quota?.blocked(a.model, runOpts.priority))?.model ?? writer[0]?.model;
        chain = [...checker.filter((a) => a.model !== writerNow), ...checker.filter((a) => a.model === writerNow)];
      } else chain = writer;
      const { result, fallbackReason } = await withRetries(
        chain,
        (adapter) => adapter.generateJson(req),
        logAttempt,
        policy,
        { quota, priority: runOpts.priority },
      );
      cache.set(cacheKey, result);
      return { result, log: servedLog(result, fallbackReason) };
    },
  };
}
