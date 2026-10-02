import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { PromptCache } from './cache.js';
import { loadEnv } from './env.js';
import {
  createJsonOrchestrator,
  createOrchestrator,
  createSentenceOrchestrator,
} from './orchestrator.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAiAdapter } from './providers/openai.js';
import type {
  JsonTaskAdapter,
  JsonTaskResult,
  ProviderAdapter,
  SentenceGenAdapter,
  SentenceProviderResult,
} from './providers/types.js';
import {
  loadGlossPromptTemplates,
  loadJournalPromptTemplates,
  loadPromptTemplate,
  loadSentenceGenPromptTemplate,
} from './prompt.js';
import { RateLimiter } from './rate-limit.js';
import { FileSyncStore } from './sync-store.js';
import { loadScenarioStore } from './scenarios.js';

// Load apps/proxy/.env if present (src/ and dist/ are both one level below it).
// Real environment variables win; loadEnvFile never overrides existing ones.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = loadEnv();

if (!env.SITE_CODE) {
  console.error(
    '[an-an-proxy] SITE_CODE is not set. Refusing to start: without it anyone could spend the AI keys and read/overwrite saved progress. ' +
      'Set SITE_CODE (e.g. in apps/proxy/.env) — see apps/proxy/README.md.',
  );
  process.exit(1);
}

if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
  console.warn(
    '[an-an-proxy] WARNING: neither GEMINI_API_KEY nor OPENAI_API_KEY is set. ' +
      '/v1/turn, /v1/sentences and /v1/journal-* will fail on every request until at least one is configured (see apps/proxy/README.md).',
  );
} else if (!env.GEMINI_API_KEY) {
  console.warn(
    '[an-an-proxy] GEMINI_API_KEY not set — running OpenAI-only (no fallback provider).',
  );
} else if (!env.OPENAI_API_KEY) {
  console.warn(
    '[an-an-proxy] OPENAI_API_KEY not set — running Gemini-only (no fallback provider).',
  );
}

class DisabledAdapter implements ProviderAdapter, SentenceGenAdapter, JsonTaskAdapter {
  readonly configured = false;
  constructor(public readonly name: 'gemini' | 'openai') {}
  async generateTurn(): Promise<never> {
    throw new Error(`${this.name} is not configured (missing API key)`);
  }
  async generateSentences(): Promise<never> {
    throw new Error(`${this.name} is not configured (missing API key)`);
  }
  async generateJson(): Promise<never> {
    throw new Error(`${this.name} is not configured (missing API key)`);
  }
}

type AnyAdapter = ProviderAdapter & SentenceGenAdapter & JsonTaskAdapter;

const gemini: AnyAdapter = env.GEMINI_API_KEY
  ? new GeminiAdapter(env.GEMINI_API_KEY, env.GEMINI_MODEL_TURN)
  : new DisabledAdapter('gemini');
const openai: AnyAdapter = env.OPENAI_API_KEY
  ? new OpenAiAdapter(env.OPENAI_API_KEY, env.OPENAI_MODEL_TURN)
  : new DisabledAdapter('openai');

// Journal tasks get their own models (env-configured), same keys.
const geminiJournal: JsonTaskAdapter = env.GEMINI_API_KEY
  ? new GeminiAdapter(env.GEMINI_API_KEY, env.GEMINI_MODEL_JOURNAL)
  : new DisabledAdapter('gemini');
const openaiJournal: JsonTaskAdapter = env.OPENAI_API_KEY
  ? new OpenAiAdapter(env.OPENAI_API_KEY, env.OPENAI_MODEL_JOURNAL)
  : new DisabledAdapter('openai');

const app = createApp({
  env,
  scenarioStore: loadScenarioStore(),
  promptTemplate: loadPromptTemplate(env.PROMPT_VERSION),
  orchestrator: createOrchestrator(gemini, openai, new PromptCache()),
  sentencePromptTemplate: loadSentenceGenPromptTemplate(env.PROMPT_VERSION),
  sentenceOrchestrator: createSentenceOrchestrator(
    gemini,
    openai,
    new PromptCache<SentenceProviderResult>(),
  ),
  gloss: {
    prompts: loadGlossPromptTemplates(env.PROMPT_VERSION),
    orchestrator: createJsonOrchestrator(
      geminiJournal,
      openaiJournal,
      new PromptCache<JsonTaskResult<unknown>>(),
    ),
  },
  journal: {
    prompts: loadJournalPromptTemplates(env.PROMPT_VERSION),
    orchestrator: createJsonOrchestrator(
      geminiJournal,
      openaiJournal,
      new PromptCache<JsonTaskResult<unknown>>(),
    ),
  },
  siteCode: env.SITE_CODE,
  sync: new FileSyncStore(env.SYNC_DIR ?? fileURLToPath(new URL('../sync-data', import.meta.url))),
  rateLimiter: new RateLimiter({
    requestsPerMinute: env.RATE_LIMIT_PER_MINUTE,
    dailyTokenBudget: env.DAILY_TOKEN_BUDGET,
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[an-an-proxy] listening on http://localhost:${info.port}`);
});
