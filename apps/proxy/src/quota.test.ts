import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PromptCache } from './cache.js';
import { createJsonOrchestrator, type RetryPolicy } from './orchestrator.js';
import { GeminiAdapter, toProviderError } from './providers/gemini.js';
import { FakeJsonAdapter } from './providers/fake.js';
import { QuotaExhaustedError, type JsonTaskRequest, type JsonTaskResult } from './providers/types.js';
import { FileQuotaStore, MemoryQuotaStore, QuotaTracker, durationMs, parseLimits, parseQuotaDetails } from './quota.js';

/**
 * Phase 33 acceptance: a fake Gemini (the real SDK over a stubbed fetch) answering the owner's
 * exact 429 for gemini-2.5-flash (GenerateRequestsPerDayPerProjectPerModel-FreeTier, retryDelay
 * 50850s, limit 20).
 */
const OWNER_429 = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/gemini-429-free-tier-daily.json', import.meta.url)), 'utf8'),
) as { error: { message: string; details: unknown[] } };

const Answer = z.object({ ok: z.boolean() });
const req: JsonTaskRequest<z.infer<typeof Answer>> = {
  task: '/v1/test',
  systemPrompt: 'sys',
  userMessage: 'hello',
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  parse: (raw) => Answer.parse(raw),
};
const instant: RetryPolicy = { backoffMs: 0, maxWaitMs: 8_000, sleep: async () => {} };

/** 09:00 in Los Angeles: 50850 s later is 23:07 the same Pacific day, before the midnight reset. */
const T0 = new Date('2026-10-10T16:00:00Z');

/** Models answering 429 with the owner's body; the rest answer {"ok":true}. Counts calls per model. */
function fakeGemini(out: Set<string>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const model = String(url).match(/models\/([^:]+):/)?.[1] ?? '?';
    calls.push(model);
    if (out.has(model))
      return new Response(JSON.stringify(OWNER_429), { status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'application/json' } });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return calls;
}

function orchestrator(models: string[], quota: QuotaTracker, checker?: string[]) {
  return createJsonOrchestrator(
    models.map((m) => new GeminiAdapter('test-key', m)),
    undefined,
    new PromptCache<JsonTaskResult<unknown>>(),
    () => {},
    { policy: instant, quota, ...(checker ? { checker: checker.map((m) => new GeminiAdapter('test-key', m)) } : {}) },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('reading a 429 (Phase 33)', () => {
  it("the owner's 429 is a daily quota: limit 20, retry in 50850 s", async () => {
    fakeGemini(new Set(['gemini-2.5-flash']));
    const err = await new GeminiAdapter('k', 'gemini-2.5-flash').generateJson(req).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'quota', retryAfterMs: 50_850_000, quotaLimit: 20 });
  });

  it('a per-minute quota stays a short wait', () => {
    const e = Object.assign(new Error('[429 Too Many Requests] quota'), {
      status: 429,
      errorDetails: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
      ],
    });
    expect(toProviderError(e)).toMatchObject({ reason: 'rate_limited', retryAfterMs: 7_000 });
    expect(parseQuotaDetails(e)).toMatchObject({ daily: false, perMinute: true });
  });

  it('reads the same facts from the message when there are no details', () => {
    const q = parseQuotaDetails(new Error(OWNER_429.error.message + ' GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
    expect(q).toMatchObject({ daily: true, limit: 20 });
    expect(q.retryAfterMs).toBe(durationMs('14h7m30.481637226s'));
    expect(durationMs('50850s')).toBe(50_850_000);
    expect(durationMs('1h')).toBe(3_600_000);
  });

  it('parses configured limits', () => {
    expect(parseLimits('gemini-2.5-flash=20, gemini-x = 1000,bad')).toEqual({ 'gemini-2.5-flash': 20, 'gemini-x': 1000 });
  });
});

describe('a quota-aware model chain (Phase 33)', () => {
  let now: Date;
  let dir: string;
  beforeEach(() => {
    now = T0;
    dir = mkdtempSync(path.join(tmpdir(), 'anan-quota-'));
  });
  const tracker = () => new QuotaTracker({ store: new FileQuotaStore(path.join(dir, 'quota.json')), now: () => now });
  const chain = ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'];

  it('after the daily 429 the next request goes to the next model with no call to 2.5-flash; a restart still skips it; after the delay it is tried again', async () => {
    const calls = fakeGemini(new Set(['gemini-2.5-flash']));
    const quota = tracker();
    const orch = orchestrator(chain, quota);

    const first = await orch.run(req, { noCache: true });
    expect(first.result.model).toBe('gemini-3.5-flash-lite');
    expect(calls).toEqual(['gemini-2.5-flash', 'gemini-3.5-flash-lite']);

    calls.length = 0;
    expect((await orch.run(req, { noCache: true })).result.model).toBe('gemini-3.5-flash-lite');
    expect(calls).toEqual(['gemini-3.5-flash-lite']);

    // a proxy restart: a new tracker and orchestrator over the same file
    calls.length = 0;
    const restarted = orchestrator(chain, tracker());
    expect((await restarted.run(req, { noCache: true })).result.model).toBe('gemini-3.5-flash-lite');
    expect(calls).toEqual(['gemini-3.5-flash-lite']);
    const usage = tracker().usage({ check: chain });
    expect(usage.models.find((m) => m.model === 'gemini-2.5-flash')).toMatchObject({ exhausted: true, limit: 20, calls: 20 });

    // after the retry delay: 2.5-flash is tried again (and now answers)
    calls.length = 0;
    now = new Date(T0.getTime() + 50_851_000);
    const later = fakeGemini(new Set());
    expect((await orchestrator(chain, tracker()).run(req, { noCache: true })).result.model).toBe('gemini-2.5-flash');
    expect(later).toEqual(['gemini-2.5-flash']);
  });

  it('a daily quota lasts until midnight Pacific at most', () => {
    const quota = new QuotaTracker({ now: () => new Date('2026-10-10T23:00:00Z') }); // 16:00 PDT
    quota.markExhausted('m', { retryAfterMs: 50_850_000 });
    expect(quota.resetsAt(['m']).toISOString()).toBe('2026-10-11T07:00:00.000Z');
  });

  it('every model out: QuotaExhaustedError with when the first one is back', async () => {
    fakeGemini(new Set(chain));
    const orch = orchestrator(chain, tracker());
    const err = await orch.run(req, { noCache: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect((err as QuotaExhaustedError).resetsAt.toISOString()).toBe(new Date(T0.getTime() + 50_850_000).toISOString());
    // and the next request makes no call at all
    const calls = fakeGemini(new Set());
    expect(await orch.run(req, { noCache: true }).catch((e: unknown) => e)).toBeInstanceOf(QuotaExhaustedError);
    expect(calls).toEqual([]);
  });

  it('the checker prefers a model other than the writer’s, and uses it when nothing else has quota', async () => {
    const calls = fakeGemini(new Set());
    const quota = tracker();
    const orch = orchestrator(['gemini-w', 'gemini-c'], quota, ['gemini-w', 'gemini-c']);
    expect((await orch.run(req, { checker: true, noCache: true })).result.model).toBe('gemini-c');
    quota.markExhausted('gemini-c', { retryAfterMs: 3_600_000 });
    calls.length = 0;
    expect((await orch.run(req, { checker: true, noCache: true })).result.model).toBe('gemini-w');
    expect(calls).toEqual(['gemini-w']);
  });

  it('`model` narrows the chain to one model (a script’s --model)', async () => {
    const calls = fakeGemini(new Set());
    const orch = orchestrator(chain, tracker());
    expect((await orch.run(req, { model: 'gemini-2.5-flash-lite', noCache: true })).result.model).toBe('gemini-2.5-flash-lite');
    expect(calls).toEqual(['gemini-2.5-flash-lite']);
  });
});

describe('the live reserve (Phase 33)', () => {
  const ok = (model: string) => new FakeJsonAdapter(model, { kind: 'success', respond: () => ({ ok: true }) });

  it('batch requests never use the live reserve; live requests always may', async () => {
    const quota = new QuotaTracker({ store: new MemoryQuotaStore(), limits: { a: 20 }, now: () => T0 });
    expect(quota.reserveOf('a')).toBe(6); // 30% of 20, at least 5
    const a = ok('a');
    const orch = createJsonOrchestrator([a], undefined, new PromptCache<JsonTaskResult<unknown>>(), () => {}, { policy: instant, quota });
    for (let i = 0; i < 14; i++) await orch.run(req, { priority: 'batch', noCache: true });
    expect(a.calls).toBe(14);
    const err = await orch.run(req, { priority: 'batch', noCache: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect((err as QuotaExhaustedError).reserved).toBe(true);
    expect(a.calls).toBe(14);
    for (let i = 0; i < 6; i++) await orch.run(req, { noCache: true });
    expect(a.calls).toBe(20);
  });

  it('a batch request moves on to a model with room before using any reserve', async () => {
    const quota = new QuotaTracker({ limits: { a: 10, b: 1000 }, reserveMin: 5, now: () => T0 });
    const a = ok('a');
    const b = ok('b');
    const orch = createJsonOrchestrator([a, b], undefined, new PromptCache<JsonTaskResult<unknown>>(), () => {}, { policy: instant, quota });
    for (let i = 0; i < 8; i++) await orch.run(req, { priority: 'batch', noCache: true });
    expect([a.calls, b.calls]).toEqual([5, 3]);
    expect(quota.usage({}).models.find((m) => m.model === 'a')).toMatchObject({ calls: 5, limit: 10, reserve: 5, exhausted: false });
  });

  it('calls are counted per quota day and reset with it', () => {
    let at = new Date('2026-10-11T06:30:00Z'); // 23:30 PDT
    const quota = new QuotaTracker({ now: () => at });
    quota.recordCall('a');
    quota.bump('stories');
    expect(quota.usage({}).models[0]).toMatchObject({ calls: 1 });
    expect(quota.count('stories')).toBe(1);
    at = new Date('2026-10-11T07:30:00Z'); // 00:30 PDT, the next quota day
    expect(quota.usage({}).models[0]).toMatchObject({ calls: 0 });
    expect(quota.count('stories')).toBe(0);
  });
});
