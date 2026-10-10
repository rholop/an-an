import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { PromptCache } from './cache.js';
import { ignoredLegacyModels, loadEnv, resolveChains, type Role } from './env.js';
import { DEFAULT_QUOTA_FILE, FileQuotaStore, QuotaTracker, parseLimits } from './quota.js';
import {
  createJsonOrchestrator,
  createOrchestrator,
  createSentenceOrchestrator,
} from './orchestrator.js';
import { GeminiAdapter } from './providers/gemini.js';
import type { JsonTaskResult, SentenceProviderResult } from './providers/types.js';
import {
  loadGlossPromptTemplates,
  loadJournalPromptTemplates,
  loadOpenChatPromptTemplates,
  loadStoryPromptTemplates,
  loadPromptTemplate,
  loadSentenceGenPromptTemplate,
} from './prompt.js';
import { RateLimiter } from './rate-limit.js';
import { FileAudioStore } from './audio-store.js';
import { FileTextbookStore } from './textbook-store.js';
import { FileSyncStore } from './sync-store.js';
import { loadOpenChatPersona, loadScenarioStore } from './scenarios.js';

// Load apps/proxy/.env if present (src/ and dist/ are both one level below it).
// Real environment variables win; loadEnvFile never overrides existing ones.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = loadEnv();

// Phase 25: Gemini only (free tier; the owner's decision). Without a key nothing works.
if (!env.GEMINI_API_KEY) {
  console.error(
    '[an-an-proxy] GEMINI_API_KEY is not set. Refusing to start: every AI route needs it. ' +
      'Set GEMINI_API_KEY (e.g. in apps/proxy/.env) — see apps/proxy/README.md.',
  );
  process.exit(1);
}

if (!env.SITE_CODE) {
  console.error(
    '[an-an-proxy] SITE_CODE is not set. Refusing to start: without it anyone could spend the AI key and read/overwrite saved progress. ' +
      'Set SITE_CODE (e.g. in apps/proxy/.env) — see apps/proxy/README.md.',
  );
  process.exit(1);
}

const key = env.GEMINI_API_KEY;
// Phase 33: one chain of free-tier Gemini models per role, sharing one quota tracker (also read by
// the scripts and `pnpm ai:quota`). Models out of free quota are skipped without a call.
const chains = resolveChains(env);
const ignored = ignoredLegacyModels(env);
if (ignored.length > 0)
  console.warn(
    `[an-an-proxy] ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} no longer read: each role uses a chain of models now (GEMINI_CHAIN_TURN/JOURNAL/STORY/CHECK, see apps/proxy/README.md). Chains: ${JSON.stringify(chains)}`,
  );
const quota = new QuotaTracker({
  store: new FileQuotaStore(env.QUOTA_FILE ?? DEFAULT_QUOTA_FILE),
  limits: parseLimits(env.GEMINI_DAILY_LIMITS),
  reserveShare: env.GEMINI_BATCH_RESERVE_SHARE,
  reserveMin: env.GEMINI_BATCH_RESERVE_MIN,
});
const adapters = new Map<string, GeminiAdapter>();
const adapter = (model: string) => {
  let a = adapters.get(model);
  if (!a) adapters.set(model, (a = new GeminiAdapter(key, model)));
  return a;
};
const chain = (role: Role) => chains[role].map(adapter);
const jsonOrchestrator = (ttlMs?: number) =>
  createJsonOrchestrator(chain('journal'), undefined, new PromptCache<JsonTaskResult<unknown>>(ttlMs), undefined, {
    checker: chain('check'),
    quota,
  });

const app = createApp({
  env,
  scenarioStore: loadScenarioStore(),
  promptTemplate: loadPromptTemplate(env.PROMPT_VERSION),
  orchestrator: createOrchestrator(chain('turn'), undefined, new PromptCache(), undefined, undefined, quota),
  sentencePromptTemplate: loadSentenceGenPromptTemplate(env.PROMPT_VERSION),
  sentenceOrchestrator: createSentenceOrchestrator(
    chain('turn'),
    undefined,
    new PromptCache<SentenceProviderResult>(),
    undefined,
    undefined,
    quota,
  ),
  gloss: {
    prompts: loadGlossPromptTemplates(env.PROMPT_VERSION),
    orchestrator: jsonOrchestrator(),
  },
  journal: {
    prompts: loadJournalPromptTemplates(env.PROMPT_VERSION),
    orchestrator: jsonOrchestrator(),
  },
  openChat: (() => {
    const prompts = loadOpenChatPromptTemplates(env.PROMPT_VERSION);
    return {
      persona: loadOpenChatPersona(),
      promptTemplate: prompts.turn,
      topicWordsPrompt: prompts.topicWords,
      // A topic's word list rarely changes: keep it for a day, per process.
      topicWordsOrchestrator: jsonOrchestrator(24 * 60 * 60_000),
    };
  })(),
  story: {
    prompts: loadStoryPromptTemplates(env.PROMPT_VERSION),
    // The checker stays a separate fresh call that never sees the prompt or the lists.
    orchestrator: createJsonOrchestrator(chain('story'), undefined, new PromptCache<JsonTaskResult<unknown>>(), undefined, {
      checker: chain('check'),
      quota,
    }),
  },
  siteCode: env.SITE_CODE,
  quota,
  chains,
  sync: new FileSyncStore(env.SYNC_DIR ?? fileURLToPath(new URL('../sync-data', import.meta.url))),
  audio: new FileAudioStore(env.AUDIO_DIR ?? fileURLToPath(new URL('../audio-data', import.meta.url))),
  textbook: new FileTextbookStore(
    env.TEXTBOOK_DIR ?? fileURLToPath(new URL('../../../data/curriculum', import.meta.url)),
  ),
  rateLimiter: new RateLimiter({
    requestsPerMinute: env.RATE_LIMIT_PER_MINUTE,
    dailyTokenBudget: env.DAILY_TOKEN_BUDGET,
  }),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[an-an-proxy] listening on http://localhost:${info.port}`);
});
