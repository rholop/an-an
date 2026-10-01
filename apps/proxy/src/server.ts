import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { PromptCache } from './cache.js';
import { loadEnv } from './env.js';
import { createOrchestrator } from './orchestrator.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAiAdapter } from './providers/openai.js';
import type { ProviderAdapter } from './providers/types.js';
import { loadPromptTemplate } from './prompt.js';
import { RateLimiter } from './rate-limit.js';
import { loadScenarioStore } from './scenarios.js';

// Load apps/proxy/.env if present (src/ and dist/ are both one level below it).
// Real environment variables win; loadEnvFile never overrides existing ones.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = loadEnv();

if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
  console.warn(
    '[an-an-proxy] WARNING: neither GEMINI_API_KEY nor OPENAI_API_KEY is set. ' +
      '/v1/turn will fail on every request until at least one is configured (see apps/proxy/README.md).',
  );
} else if (!env.GEMINI_API_KEY) {
  console.warn('[an-an-proxy] GEMINI_API_KEY not set — running OpenAI-only (no fallback provider).');
} else if (!env.OPENAI_API_KEY) {
  console.warn('[an-an-proxy] OPENAI_API_KEY not set — running Gemini-only (no fallback provider).');
}

class DisabledAdapter implements ProviderAdapter {
  constructor(public readonly name: 'gemini' | 'openai') {}
  async generateTurn(): Promise<never> {
    throw new Error(`${this.name} is not configured (missing API key)`);
  }
}

const gemini: ProviderAdapter = env.GEMINI_API_KEY
  ? new GeminiAdapter(env.GEMINI_API_KEY, env.GEMINI_MODEL_TURN)
  : new DisabledAdapter('gemini');
const openai: ProviderAdapter = env.OPENAI_API_KEY
  ? new OpenAiAdapter(env.OPENAI_API_KEY, env.OPENAI_MODEL_TURN)
  : new DisabledAdapter('openai');

const app = createApp({
  env,
  scenarioStore: loadScenarioStore(),
  promptTemplate: loadPromptTemplate(env.PROMPT_VERSION),
  orchestrator: createOrchestrator(gemini, openai, new PromptCache()),
  rateLimiter: new RateLimiter({ requestsPerMinute: env.RATE_LIMIT_PER_MINUTE, dailyTokenBudget: env.DAILY_TOKEN_BUDGET }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[an-an-proxy] listening on http://localhost:${info.port}`);
});
