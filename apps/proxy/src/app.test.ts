import { describe, expect, it } from 'vitest';
import type { Scenario, SentenceGenRequest, TurnRequest } from '@anan/core';
import { createApp } from './app.js';
import { loadPromptTemplate, loadSentenceGenPromptTemplate } from './prompt.js';
import { RateLimiter } from './rate-limit.js';
import type { ScenarioStore } from './scenarios.js';
import type { Orchestrator, SentenceOrchestrator } from './orchestrator.js';
import { fakeSentenceGenResponse, fakeTurnResponse } from './providers/fake.js';

const scenario: Scenario = {
  id: 'tea-shop',
  title: 'Ordering a drink',
  levelRange: { min: 'N1', max: 'L2' },
  npc: { id: 'clerk', name: '店員', personality: 'friendly', speechStyle: 'short', particles: [] },
  setting: 'A counter.',
  goalSteps: [{ id: 'order', description: 'Order', keywordHints: [] }],
  vocabExtras: [],
  opener: { zh: '歡迎光臨！', en: 'Welcome!' },
  successLine: { zh: '謝謝！', en: 'Thanks!' },
};

function fakeScenarioStore(scenarios: Scenario[] = [scenario]): ScenarioStore {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  return { get: (id) => byId.get(id), all: () => scenarios };
}

function fakeOrchestrator(behavior: 'success' | 'throw' = 'success'): Orchestrator {
  return {
    async run() {
      if (behavior === 'throw') throw new Error('both providers failed');
      return {
        result: { response: fakeTurnResponse(), provider: 'gemini', model: 'fake', usage: { inputTokens: 5, outputTokens: 5 } },
        log: { provider: 'gemini', model: 'fake', cached: false, usage: { inputTokens: 5, outputTokens: 5 } },
      };
    },
  };
}

function fakeSentenceOrchestrator(behavior: 'success' | 'throw' = 'success'): SentenceOrchestrator {
  return {
    async run() {
      if (behavior === 'throw') throw new Error('both providers failed');
      return {
        result: { response: fakeSentenceGenResponse(), provider: 'gemini', model: 'fake', usage: { inputTokens: 5, outputTokens: 5 } },
        log: { provider: 'gemini', model: 'fake', cached: false, usage: { inputTokens: 5, outputTokens: 5 } },
      };
    },
  };
}

function buildApp(
  overrides: {
    rateLimiter?: RateLimiter;
    orchestrator?: Orchestrator;
    sentenceOrchestrator?: SentenceOrchestrator;
    scenarioStore?: ScenarioStore;
  } = {},
) {
  return createApp({
    env: { CORS_ORIGIN: 'https://example.com' },
    scenarioStore: overrides.scenarioStore ?? fakeScenarioStore(),
    promptTemplate: loadPromptTemplate('v1'),
    orchestrator: overrides.orchestrator ?? fakeOrchestrator(),
    sentencePromptTemplate: loadSentenceGenPromptTemplate('v1'),
    sentenceOrchestrator: overrides.sentenceOrchestrator ?? fakeSentenceOrchestrator(),
    rateLimiter: overrides.rateLimiter ?? new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 1_000_000 }),
    log: () => {}, // silence logs in tests
  });
}

const validTurnRequest: TurnRequest = {
  scenarioId: 'tea-shop',
  npcId: 'clerk',
  history: [],
  learnerLevel: 'N2',
  vocab: { knownSample: ['我'], due: [], targets: [], allowedExtras: [] },
  scaffolding: 'high',
  englishFallback: false,
};

describe('GET /v1/health', () => {
  it('returns ok without needing an install id', async () => {
    const app = buildApp();
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /v1/turn', () => {
  it('requires an X-Install-Id header', async () => {
    const app = buildApp();
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validTurnRequest),
    });
    expect(res.status).toBe(400);
  });

  it('succeeds with a valid request and install id, returning the TurnResponse shape', async () => {
    const app = buildApp();
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validTurnRequest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply_zh: string };
    expect(body.reply_zh).toBe('你好！');
  });

  it('locks CORS to the configured origin', async () => {
    const app = buildApp();
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1', origin: 'https://example.com' },
      body: JSON.stringify(validTurnRequest),
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
  });

  it('rejects malformed JSON body', async () => {
    const app = buildApp();
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a body that does not match TurnRequestSchema', async () => {
    const app = buildApp();
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify({ scenarioId: 'tea-shop' }), // missing required fields
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown scenarioId', async () => {
    const app = buildApp();
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify({ ...validTurnRequest, scenarioId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('enforces the per-minute rate limit', async () => {
    const app = buildApp({ rateLimiter: new RateLimiter({ requestsPerMinute: 1, dailyTokenBudget: 1_000_000 }) });
    const req = () =>
      app.request('/v1/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
        body: JSON.stringify(validTurnRequest),
      });
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });

  it('enforces the daily token budget', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 1 });
    const app = buildApp({ rateLimiter: limiter });
    limiter.recordUsage('client-1', 1);
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validTurnRequest),
    });
    expect(res.status).toBe(429);
  });

  it('returns 502 when both providers fail', async () => {
    const app = buildApp({ orchestrator: fakeOrchestrator('throw') });
    const res = await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validTurnRequest),
    });
    expect(res.status).toBe(502);
  });

  it('records token usage against the rate limiter after a successful turn', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 1_000_000 });
    const app = buildApp({ rateLimiter: limiter });
    await app.request('/v1/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validTurnRequest),
    });
    expect(limiter.remainingBudget('client-1')).toBe(1_000_000 - 10); // 5 input + 5 output from the fake
  });
});

const validSentenceGenRequest: SentenceGenRequest = {
  word: { headword: '珍珠奶茶', pinyin: 'zhēn zhū nǎi chá', level: 'N2', glossEn: 'bubble tea' },
  allowedVocab: ['我', '要', '一杯'],
  count: 5,
};

describe('POST /v1/sentences', () => {
  it('requires an X-Install-Id header', async () => {
    const app = buildApp();
    const res = await app.request('/v1/sentences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSentenceGenRequest),
    });
    expect(res.status).toBe(400);
  });

  it('succeeds with a valid request and install id, returning the SentenceGenResponse shape', async () => {
    const app = buildApp();
    const res = await app.request('/v1/sentences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validSentenceGenRequest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sentences: { zh: string }[] };
    expect(body.sentences[0]!.zh).toBe('我喜歡喝珍珠奶茶。');
  });

  it('rejects malformed JSON body', async () => {
    const app = buildApp();
    const res = await app.request('/v1/sentences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a body that does not match SentenceGenRequestSchema', async () => {
    const app = buildApp();
    const res = await app.request('/v1/sentences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify({ word: { headword: '珍珠奶茶' } }), // missing required fields
    });
    expect(res.status).toBe(400);
  });

  it('enforces the per-minute rate limit', async () => {
    const app = buildApp({ rateLimiter: new RateLimiter({ requestsPerMinute: 1, dailyTokenBudget: 1_000_000 }) });
    const req = () =>
      app.request('/v1/sentences', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
        body: JSON.stringify(validSentenceGenRequest),
      });
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
  });

  it('returns 502 when both providers fail', async () => {
    const app = buildApp({ sentenceOrchestrator: fakeSentenceOrchestrator('throw') });
    const res = await app.request('/v1/sentences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validSentenceGenRequest),
    });
    expect(res.status).toBe(502);
  });

  it('records token usage against the rate limiter after a successful generation', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 1_000_000 });
    const app = buildApp({ rateLimiter: limiter });
    await app.request('/v1/sentences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'client-1' },
      body: JSON.stringify(validSentenceGenRequest),
    });
    expect(limiter.remainingBudget('client-1')).toBe(1_000_000 - 10);
  });
});
