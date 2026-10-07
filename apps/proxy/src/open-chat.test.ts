import { describe, expect, it } from 'vitest';
import type { OpenChatPersona, OpenTurnRequest, TurnHistoryEntry } from '@anan/core';
import { createApp } from './app.js';
import { PromptCache } from './cache.js';
import { createJsonOrchestrator, createOrchestrator } from './orchestrator.js';
import {
  FakeJsonAdapter,
  FakeProviderAdapter,
  fakeSentenceGenResponse,
  fakeTurnResponse,
} from './providers/fake.js';
import type { JsonTaskResult } from './providers/types.js';
import {
  buildOpenSystemPrompt,
  loadGlossPromptTemplates,
  loadJournalPromptTemplates,
  loadOpenChatPromptTemplates,
  loadPromptTemplate,
  loadSentenceGenPromptTemplate,
  normalizeTopic,
} from './prompt.js';
import { RateLimiter } from './rate-limit.js';
import { loadOpenChatPersona } from './scenarios.js';

const persona: OpenChatPersona = loadOpenChatPersona();
const templates = loadOpenChatPromptTemplates('v1');

const openRequest: OpenTurnRequest = {
  mode: 'open',
  topic: 'food you like',
  tiers: { a: ['我', '你', '吃', '飯'], b: ['喜歡'], cAllowed: ['夜市'] },
  summary: 'Learner: 我喜歡吃飯',
  grammar: ['V + 了'],
  history: [{ role: 'learner', zh: '我喜歡吃飯。' }],
  learnerLevel: 'N2',
  scaffolding: 'high',
  englishFallback: false,
};

function buildApp(opts: { gemini?: FakeProviderAdapter; openai?: FakeProviderAdapter; topicWords?: FakeJsonAdapter } = {}) {
  const gemini = opts.gemini ?? new FakeProviderAdapter('gemini', { kind: 'success', response: fakeTurnResponse() });
  const openai = opts.openai ?? new FakeProviderAdapter('openai', { kind: 'success', response: fakeTurnResponse({ reply_zh: '你喜歡吃什麼？' }) });
  const topicGemini =
    opts.topicWords ??
    new FakeJsonAdapter('gemini', { kind: 'success', respond: () => ({ words: ['吃', '飯', '夜市'] }) });
  const topicOpenai = new FakeJsonAdapter('openai', { kind: 'success', respond: () => ({ words: ['吃'] }) });
  const jsonOrch = () =>
    createJsonOrchestrator(topicGemini, topicOpenai, new PromptCache<JsonTaskResult<unknown>>());
  const never = {
    run: async () => {
      throw new Error('unused');
    },
  };
  const app = createApp({
    env: { CORS_ORIGIN: 'https://example.com' },
    scenarioStore: { get: () => undefined, all: () => [] },
    promptTemplate: loadPromptTemplate('v1'),
    orchestrator: createOrchestrator(gemini, openai, new PromptCache(), () => {}),
    sentencePromptTemplate: loadSentenceGenPromptTemplate('v1'),
    sentenceOrchestrator: { run: async () => { throw new Error(`unused ${JSON.stringify(fakeSentenceGenResponse())}`); } },
    journal: { prompts: loadJournalPromptTemplates('v1'), orchestrator: never as never },
    gloss: { prompts: loadGlossPromptTemplates('v1'), orchestrator: never as never },
    openChat: {
      persona,
      promptTemplate: templates.turn,
      topicWordsPrompt: templates.topicWords,
      topicWordsOrchestrator: jsonOrch(),
    },
    siteCode: 'tofu',
    sync: {} as never,
    audio: {} as never,
    rateLimiter: new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 1_000_000 }),
    log: () => {},
  });
  return { app, gemini, openai, topicGemini };
}

const post = (app: ReturnType<typeof buildApp>['app'], path: string, body: unknown, code = 'tofu') =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-install-id': 'c1:rowan', 'x-site-code': code },
    body: JSON.stringify(body),
  });

describe('open-chat prompt', () => {
  it('fills the persona, the three tiers, the summary and the grammar; leaves no placeholder', () => {
    const p = buildOpenSystemPrompt(templates.turn, persona, openRequest);
    expect(p).toContain('安安');
    expect(p).toContain('我、你、吃、飯'); // tier A
    expect(p).toContain('喜歡'); // tier B
    expect(p).toContain('夜市'); // tier C
    expect(p).toContain('V + 了');
    expect(p).toContain('Learner: 我喜歡吃飯');
    expect(p).toContain('food you like');
    expect(p).not.toMatch(/\{\{\w+\}\}/);
    expect(p).not.toContain('<!--');
    expect(p).toContain('at most 3');
  });

  it('Just chat (no topic) says so; a hard topic changes the instruction', () => {
    const none = buildOpenSystemPrompt(templates.turn, persona, { ...openRequest, topic: '', summary: undefined });
    expect(none).toContain('ask a simple question to start');
    expect(none).toContain('(nothing yet)');
    const hard = buildOpenSystemPrompt(templates.turn, persona, { ...openRequest, hardTopic: true });
    expect(hard).toContain('harder topic');
    expect(buildOpenSystemPrompt(templates.turn, persona, openRequest)).not.toContain('harder topic');
  });
});

describe('POST /v1/turn (mode: open)', () => {
  it('answers with the Phase 3 turn shape, goal_progress empty', async () => {
    const { app } = buildApp();
    const res = await post(app, '/v1/turn', openRequest);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply_zh: string; goal_progress: unknown[] };
    expect(body.reply_zh).toBe('你好！');
    expect(body.goal_progress).toEqual([]);
  });

  it('requires the household code', async () => {
    const { app } = buildApp();
    expect((await post(app, '/v1/turn', openRequest, 'wrong')).status).toBe(401);
  });

  it('rejects a malformed open request (no scenario fields needed, but tiers are)', async () => {
    const { app } = buildApp();
    const res = await post(app, '/v1/turn', { ...openRequest, tiers: undefined });
    expect(res.status).toBe(400);
  });

  it('forcing a Gemini 429 makes the turn succeed via OpenAI (same contract as Phase 3)', async () => {
    const { app, gemini, openai } = buildApp({
      gemini: new FakeProviderAdapter('gemini', { kind: 'error', reason: 'rate_limit' }),
    });
    const res = await post(app, '/v1/turn', openRequest);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-served-by')).toBe('openai');
    expect(((await res.json()) as { reply_zh: string }).reply_zh).toBe('你喜歡吃什麼？');
    expect(gemini.calls).toBe(1);
    expect(openai.calls).toBe(1);
  });

  it('scenario turns still need a scenario id', async () => {
    const { app } = buildApp();
    const res = await post(app, '/v1/turn', {
      scenarioId: 'nope',
      npcId: 'x',
      history: [],
      learnerLevel: 'N1',
      vocab: { knownSample: [], due: [], targets: [], allowedExtras: [] },
      scaffolding: 'high',
      englishFallback: false,
    });
    expect(res.status).toBe(404);
  });

  it('passes regeneration feedback through to the system prompt', async () => {
    let seen = '';
    const gemini = new FakeProviderAdapter('gemini', { kind: 'success', response: fakeTurnResponse() });
    const orig = gemini.generateTurn.bind(gemini);
    gemini.generateTurn = async (sys: string, h: TurnHistoryEntry[]) => {
      seen = sys;
      return orig(sys, h);
    };
    const { app } = buildApp({ gemini });
    await post(app, '/v1/turn', { ...openRequest, feedback: 'Too hard: 新聞' });
    expect(seen).toContain('Your previous reply needs a redo');
    expect(seen).toContain('新聞');
  });
});

describe('POST /v1/topic-words', () => {
  it('returns the words, needs the code, and validates the body', async () => {
    const { app } = buildApp();
    const res = await post(app, '/v1/topic-words', { topic: 'food', level: 'L1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ words: ['吃', '飯', '夜市'] });
    expect((await post(app, '/v1/topic-words', { topic: 'food', level: 'L1' }, 'wrong')).status).toBe(401);
    expect((await post(app, '/v1/topic-words', { topic: '', level: 'L1' })).status).toBe(400);
    expect((await post(app, '/v1/topic-words', { topic: 'food', level: 'L9' })).status).toBe(400);
  });

  it('is cached by topic + level (case and spacing do not matter)', async () => {
    const { app, topicGemini } = buildApp();
    await post(app, '/v1/topic-words', { topic: 'Food you like', level: 'L1' });
    await post(app, '/v1/topic-words', { topic: '  food  you like ', level: 'L1' });
    expect(topicGemini.calls).toBe(1);
    await post(app, '/v1/topic-words', { topic: 'food you like', level: 'N1' });
    expect(topicGemini.calls).toBe(2);
    expect(normalizeTopic('  Food  You LIKE ')).toBe('food you like');
  });

  it('falls back to OpenAI when Gemini is rate limited', async () => {
    const { app } = buildApp({ topicWords: new FakeJsonAdapter('gemini', { kind: 'error', reason: 'rate_limit' }) });
    const res = await post(app, '/v1/topic-words', { topic: 'weekend', level: 'N2' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-served-by')).toBe('openai');
  });
});
