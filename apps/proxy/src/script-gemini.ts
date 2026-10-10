// Phase 33 Part B: the scripts (naturalness pass, evals) call Gemini through the same model chains
// and the same quota tracker file as the proxy, as batch requests: they skip models out of free
// quota, leave each model's reserve for the live app, and stop with QuotaExhaustedError (and when
// it resets) instead of failing batch after batch.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PromptCache } from './cache.js';
import { loadEnv, resolveChains, type Env, type Role } from './env.js';
import { createJsonOrchestrator, type AttemptLogger } from './orchestrator.js';
import { GeminiAdapter } from './providers/gemini.js';
import type { JsonTaskAdapter, JsonTaskRequest, JsonTaskResult } from './providers/types.js';
import { DEFAULT_QUOTA_FILE, FileQuotaStore, QuotaTracker, parseLimits } from './quota.js';

/** GEMINI_MODEL_CHECK given on the command line (`GEMINI_MODEL_CHECK=… pnpm … naturalness`), read
 * before apps/proxy/.env is loaded: an old GEMINI_MODEL_CHECK line in .env is not an override. */
const SHELL_MODEL_CHECK = process.env.GEMINI_MODEL_CHECK;

/** apps/proxy/.env, as the server loads it (real environment variables win). */
export function loadProxyEnv(): Env {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
  return loadEnv();
}

/** The proxy's quota tracker over its state file (shared with a running proxy). */
export function sharedQuota(env: Env): QuotaTracker {
  return new QuotaTracker({
    store: new FileQuotaStore(env.QUOTA_FILE ?? DEFAULT_QUOTA_FILE),
    limits: parseLimits(env.GEMINI_DAILY_LIMITS),
    reserveShare: env.GEMINI_BATCH_RESERVE_SHARE,
    reserveMin: env.GEMINI_BATCH_RESERVE_MIN,
  });
}

/** `--model <name>` from argv (or `--model=<name>`). */
export function modelFlag(argv: readonly string[]): string | undefined {
  const at = argv.findIndex((a) => a === '--model' || a.startsWith('--model='));
  if (at < 0) return undefined;
  return argv[at]!.includes('=') ? argv[at]!.split('=')[1] : argv[at + 1];
}

export interface ScriptGemini {
  /** The models this script will try, in order. */
  chain: string[];
  quota: QuotaTracker;
  run<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>>;
}

/**
 * The role's chain (or just `model`, the script's `--model`; for the checker role also
 * GEMINI_MODEL_CHECK given on the command line), as batch requests on the shared tracker. Never answered from a cache.
 */
export function geminiForScript(opts: {
  role: Role;
  model?: string;
  env?: Env;
  /** Tests: adapters instead of real Gemini. */
  adapter?: (model: string) => JsonTaskAdapter;
  quota?: QuotaTracker;
  log?: AttemptLogger;
}): ScriptGemini {
  const env = opts.env ?? loadProxyEnv();
  const override = opts.model ?? (opts.role === 'check' && !opts.env ? SHELL_MODEL_CHECK : undefined);
  const chain = override ? [override] : resolveChains(env)[opts.role];
  const key = env.GEMINI_API_KEY;
  if (!opts.adapter && !key) throw new Error('GEMINI_API_KEY is not set (apps/proxy/.env or the environment)');
  const make = opts.adapter ?? ((model: string) => new GeminiAdapter(key!, model));
  const quota = opts.quota ?? sharedQuota(env);
  const orch = createJsonOrchestrator(chain.map(make), undefined, new PromptCache<JsonTaskResult<unknown>>(), opts.log ?? (() => {}), {
    quota,
  });
  return {
    chain,
    quota,
    run: async <T>(req: JsonTaskRequest<T>) => (await orch.run(req, { priority: 'batch', noCache: true })).result,
  };
}
