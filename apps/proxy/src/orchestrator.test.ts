import { describe, expect, it } from 'vitest';
import type { TurnHistoryEntry } from '@anan/core';
import { PromptCache } from './cache.js';
import {
  buildEffectiveSystemPrompt,
  createJsonOrchestrator,
  createOrchestrator,
  createSentenceOrchestrator,
  type RetryPolicy,
} from './orchestrator.js';
import { fakeSentenceGenResponse, fakeTurnResponse } from './providers/fake.js';
import {
  ModelsFailedError,
  ProviderRetryableError,
  type JsonTaskAdapter,
  type JsonTaskRequest,
  type JsonTaskResult,
  type ProviderAdapter,
  type ProviderFailureReason,
  type ProviderResult,
  type SentenceGenAdapter,
  type SentenceProviderResult,
} from './providers/types.js';

/**
 * Phase 25: Gemini only. The task model is tried, retried once after a wait on a retryable error
 * (429, 5xx, timeout, invalid JSON), then the fallback Gemini model is tried once. Auth errors and
 * plain errors are never retried.
 */

const history: TurnHistoryEntry[] = [{ role: 'learner', zh: '我要一杯珍珠奶茶' }];
const usage = { inputTokens: 10, outputTokens: 10 };

type Outcome = 'ok' | ProviderFailureReason | Error;

/** A Gemini model whose calls follow a script (the last entry repeats). */
class ScriptedModel implements ProviderAdapter, SentenceGenAdapter, JsonTaskAdapter {
  calls = 0;
  constructor(
    readonly model: string,
    private readonly script: Outcome[],
    private readonly retryAfterMs?: number,
  ) {}
  private next(): void {
    const o = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls++;
    if (o instanceof Error) throw o;
    if (o !== 'ok') throw new ProviderRetryableError(o, o, o === 'rate_limited' ? this.retryAfterMs : undefined);
  }
  async generateTurn(): Promise<ProviderResult> {
    this.next();
    return { response: fakeTurnResponse(), model: this.model, usage };
  }
  async generateSentences(): Promise<SentenceProviderResult> {
    this.next();
    return { response: fakeSentenceGenResponse(), model: this.model, usage };
  }
  async generateJson<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>> {
    this.next();
    return { response: req.parse({ ok: true }), model: this.model, usage };
  }
}

const waits: number[] = [];
const policy: RetryPolicy = {
  backoffMs: 1_000,
  maxWaitMs: 8_000,
  sleep: async (ms) => {
    waits.push(ms);
  },
};
const quiet = () => undefined;

describe('createOrchestrator (Gemini only)', () => {
  it('serves from the task model on a normal success', async () => {
    const primary = new ScriptedModel('gemini-task', ['ok']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const { log } = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy).run('p', history);
    expect(log).toMatchObject({ model: 'gemini-task', cached: false });
    expect(log.fallbackReason).toBeUndefined();
    expect([primary.calls, fallback.calls]).toEqual([1, 0]);
  });

  it('a 429 waits and retries the same model once', async () => {
    waits.length = 0;
    const primary = new ScriptedModel('gemini-task', ['rate_limited', 'ok']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const { log } = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy).run('p', history);
    expect(log).toMatchObject({ model: 'gemini-task', fallbackReason: 'rate_limited' });
    expect(waits).toEqual([1_000]);
    expect([primary.calls, fallback.calls]).toEqual([2, 0]);
  });

  it("honours a 429's retry-after, but never waits longer than the cap", async () => {
    waits.length = 0;
    const short = new ScriptedModel('gemini-task', ['rate_limited', 'ok'], 3_000);
    await createOrchestrator(short, undefined, new PromptCache(), quiet, policy).run('p', history);
    expect(waits).toEqual([3_000]);
    waits.length = 0;
    const long = new ScriptedModel('gemini-task', ['rate_limited'], 60_000);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const { log } = await createOrchestrator(long, fallback, new PromptCache(), quiet, policy).run('p', history);
    expect(waits).toEqual([]);
    expect(long.calls).toBe(1);
    expect(log.model).toBe('gemini-fallback');
  });

  for (const reason of ['rate_limited', 'server_error', 'timeout', 'invalid_json'] as const)
    it(`${reason} twice on the task model: the fallback Gemini model answers`, async () => {
      const primary = new ScriptedModel('gemini-task', [reason]);
      const fallback = new ScriptedModel('gemini-fallback', ['ok']);
      const { log } = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy).run('p', history);
      expect(log).toMatchObject({ model: 'gemini-fallback', fallbackReason: reason });
      expect([primary.calls, fallback.calls]).toEqual([2, 1]);
    });

  it('quota and bad requests skip the same-model retry and go to the fallback model', async () => {
    for (const reason of ['quota', 'bad_request', 'request_error'] as const) {
      const primary = new ScriptedModel('gemini-task', [reason]);
      const fallback = new ScriptedModel('gemini-fallback', ['ok']);
      const { log } = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy).run('p', history);
      expect(log.model, reason).toBe('gemini-fallback');
      expect(primary.calls, reason).toBe(1);
    }
  });

  it('an auth error is never retried', async () => {
    const primary = new ScriptedModel('gemini-task', ['auth']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const err = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy)
      .run('p', history)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelsFailedError);
    expect((err as ModelsFailedError).attempts).toEqual([{ model: 'gemini-task', reason: 'auth' }]);
    expect(fallback.calls).toBe(0);
  });

  it('a plain error propagates without a retry', async () => {
    const primary = new ScriptedModel('gemini-task', [new Error('network down')]);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const err = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy)
      .run('p', history)
      .catch((e: unknown) => e);
    expect((err as ModelsFailedError).attempts).toEqual([{ model: 'gemini-task', reason: 'error' }]);
    expect([primary.calls, fallback.calls]).toEqual([1, 0]);
  });

  it('when every try fails, the error lists each model and why', async () => {
    const primary = new ScriptedModel('gemini-task', ['server_error', 'timeout']);
    const fallback = new ScriptedModel('gemini-fallback', ['rate_limited']);
    const err = await createOrchestrator(primary, fallback, new PromptCache(), quiet, policy)
      .run('p', history)
      .catch((e: unknown) => e);
    expect((err as ModelsFailedError).attempts).toEqual([
      { model: 'gemini-task', reason: 'server_error' },
      { model: 'gemini-task', reason: 'timeout' },
      { model: 'gemini-fallback', reason: 'rate_limited' },
    ]);
  });

  it('without a fallback model (or the same one) only the task model is tried', async () => {
    const primary = new ScriptedModel('gemini-task', ['server_error']);
    await expect(createOrchestrator(primary, undefined, new PromptCache(), quiet, policy).run('p', history)).rejects.toBeInstanceOf(
      ModelsFailedError,
    );
    const same = new ScriptedModel('gemini-task', ['ok']);
    await expect(createOrchestrator(primary, same, new PromptCache(), quiet, policy).run('q', history)).rejects.toBeInstanceOf(
      ModelsFailedError,
    );
    expect(same.calls).toBe(0);
  });

  it('no new try starts after the deadline (nginx gives up at 60 s)', async () => {
    let t = 0;
    const slow: RetryPolicy = { ...policy, deadlineMs: 35_000, now: () => t };
    const primary = new ScriptedModel('gemini-task', ['timeout']);
    const orig = primary.generateTurn.bind(primary);
    primary.generateTurn = async () => {
      t += 25_000; // each try runs into the 25 s timeout
      return orig();
    };
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    await expect(createOrchestrator(primary, fallback, new PromptCache(), quiet, slow).run('p', history)).rejects.toBeInstanceOf(
      ModelsFailedError,
    );
    expect([primary.calls, fallback.calls]).toEqual([2, 0]);
  });

  it('Phase 21: alternate = start with the fallback model (and cache it separately)', async () => {
    const primary = new ScriptedModel('gemini-task', ['ok']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const orchestrator = createOrchestrator(primary, fallback, new PromptCache(), quiet, policy);
    await orchestrator.run('p', history);
    const { log } = await orchestrator.run('p', history, { alternate: true });
    expect(log).toMatchObject({ model: 'gemini-fallback', cached: false });
    expect([primary.calls, fallback.calls]).toEqual([1, 1]);
  });

  it('caches a success keyed by the full prompt and history', async () => {
    const primary = new ScriptedModel('gemini-task', ['ok']);
    const orchestrator = createOrchestrator(primary, undefined, new PromptCache(), quiet, policy);
    await orchestrator.run('p', history);
    const again = await orchestrator.run('p', history);
    expect(again.log.cached).toBe(true);
    await orchestrator.run('p', [...history, { role: 'npc', zh: '好' }]);
    await orchestrator.run('other prompt', history);
    expect(primary.calls).toBe(3);
  });
});

describe('createSentenceOrchestrator (Gemini only)', () => {
  it('retries, falls back to the other Gemini model, and caches by prompt', async () => {
    const primary = new ScriptedModel('gemini-task', ['invalid_json']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const orchestrator = createSentenceOrchestrator(primary, fallback, new PromptCache<SentenceProviderResult>(), quiet, policy);
    const { log } = await orchestrator.run('p');
    expect(log.model).toBe('gemini-fallback');
    expect((await orchestrator.run('p')).log.cached).toBe(true);
    expect([primary.calls, fallback.calls]).toEqual([2, 1]);
  });
});

describe('buildEffectiveSystemPrompt', () => {
  it('returns the prompt unchanged with no feedback', () => {
    expect(buildEffectiveSystemPrompt('base')).toBe('base');
  });

  it('appends feedback as a clearly-delimited addendum', () => {
    const out = buildEffectiveSystemPrompt('base', 'too hard');
    expect(out.startsWith('base')).toBe(true);
    expect(out).toContain('too hard');
  });
});

describe('createJsonOrchestrator (Gemini only)', () => {
  const req: JsonTaskRequest<{ ok: boolean }> = {
    task: '/v1/journal-verify',
    systemPrompt: 'check this',
    userMessage: '我喜歡喝茶。',
    jsonSchema: {},
    parse: (raw) => raw as { ok: boolean },
  };

  it('the checker (journal verify, story check) is a fresh call on the checker model', async () => {
    const primary = new ScriptedModel('gemini-task', ['ok']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const checker = new ScriptedModel('gemini-check', ['ok']);
    const orch = createJsonOrchestrator(primary, fallback, new PromptCache<JsonTaskResult<unknown>>(), quiet, { checker, policy });
    const { log } = await orch.run(req, { checker: true });
    expect(log.model).toBe('gemini-check');
    // a writer call with the same prompt does not reuse the checker's cached answer
    expect((await orch.run(req)).log).toMatchObject({ model: 'gemini-task', cached: false });
    expect([primary.calls, checker.calls]).toEqual([1, 1]);
  });

  it('when the checker model fails, the fallback model checks', async () => {
    const primary = new ScriptedModel('gemini-task', ['ok']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const checker = new ScriptedModel('gemini-check', ['quota']);
    const orch = createJsonOrchestrator(primary, fallback, new PromptCache<JsonTaskResult<unknown>>(), quiet, { checker, policy });
    expect((await orch.run(req, { checker: true })).log.model).toBe('gemini-fallback');
    expect(primary.calls).toBe(0);
  });

  it('forcing the primary Gemini model to fail: the route succeeds on GEMINI_MODEL_FALLBACK', async () => {
    const primary = new ScriptedModel('gemini-task', ['server_error']);
    const fallback = new ScriptedModel('gemini-fallback', ['ok']);
    const orch = createJsonOrchestrator(primary, fallback, new PromptCache<JsonTaskResult<unknown>>(), quiet, { policy });
    expect((await orch.run(req)).log.model).toBe('gemini-fallback');
  });

  it('caches per task + prompt + message', async () => {
    const primary = new ScriptedModel('gemini-task', ['ok']);
    const orch = createJsonOrchestrator(primary, undefined, new PromptCache<JsonTaskResult<unknown>>(), quiet, { policy });
    await orch.run(req);
    expect((await orch.run(req)).log.cached).toBe(true);
    await orch.run({ ...req, userMessage: '別的' });
    expect(primary.calls).toBe(2);
  });
});
