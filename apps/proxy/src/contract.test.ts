import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { PromptCache } from './cache.js';
import { JSON_ROUTES } from './json-routes.js';
import { createJsonOrchestrator } from './orchestrator.js';
import { GeminiAdapter } from './providers/gemini.js';
import { ModelsFailedError, type JsonTaskRequest } from './providers/types.js';
import { failureBody } from './app.js';
import { applyZodLimits, schemaAt, trimToLimits, zodLimits } from './zod-limits.js';

/**
 * Phase 25: contract tests for every JSON route against the REAL Gemini adapter (no network: the
 * SDK client is swapped for a recorder). The story 502 came from a request a provider rejected,
 * which no fake-adapter test could see.
 */

type Json = Record<string, unknown>;
/** Keywords Gemini's responseSchema accepts (an OpenAPI-3 subset). */
const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'nullable',
  'format',
  'minItems',
  'maxItems',
  'maxLength',
  'minimum',
  'maximum',
]);

function keywords(schema: unknown, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as Json;
  for (const k of Object.keys(s)) out.add(k);
  if (s.properties) for (const v of Object.values(s.properties as Json)) keywords(v, out);
  if (s.items) keywords(s.items, out);
  return out;
}

/** A minimal answer that satisfies the schema (strings 'x', numbers 0, the fewest items). */
function sample(schema: Json): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Json>;
      const req = new Set((schema.required ?? []) as string[]);
      return Object.fromEntries(
        Object.entries(props).flatMap(([k, v]) => (req.has(k) ? [[k, sample(v)]] : [])),
      );
    }
    case 'array':
      return Array.from({ length: (schema.minItems as number | undefined) ?? 0 }, () =>
        sample(schema.items as Json),
      );
    case 'string':
      return 'x';
    case 'integer':
    case 'number':
      return (schema.minimum as number | undefined) ?? 0;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

function gemini(respond: (cfg: { generationConfig: { responseSchema: Json } }) => unknown, model = 'gemini-test') {
  const adapter = new GeminiAdapter('test-key', model);
  const configs: Array<{ generationConfig: { responseSchema: Json } }> = [];
  (adapter as unknown as { client: unknown }).client = {
    getGenerativeModel: (cfg: (typeof configs)[number]) => {
      configs.push(cfg);
      return {
        generateContent: async () => {
          const r = respond(cfg);
          if (r instanceof Error) throw r;
          return {
            response: {
              text: () => JSON.stringify(r),
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            },
          };
        },
      };
    },
  };
  return { adapter, configs };
}

const task = (route: string, zod: z.ZodTypeAny, json: object): JsonTaskRequest<unknown> => {
  const limited = applyZodLimits(json, zod);
  return {
    task: route,
    systemPrompt: 'system',
    userMessage: 'user',
    jsonSchema: limited,
    parse: (raw) => zod.parse(trimToLimits(raw, limited)),
  };
};

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const policy = { backoffMs: 0, maxWaitMs: 0, sleep: async () => undefined };
const quiet = () => undefined;

describe('JSON route contracts (Phase 25, Gemini only)', () => {
  for (const { route, zod, json } of JSON_ROUTES) {
    it(`${route}: the real Gemini request is valid and carries the zod limits`, async () => {
      const limits = zodLimits(zod);
      const limited = applyZodLimits(json, zod);
      // every zod limit is in the schema the model sees
      for (const l of limits) {
        const node = schemaAt(limited, l.path);
        if (node) expect(node[l.keyword], `${route} ${l.path} ${l.keyword}`).toBe(l.value);
      }
      for (const k of keywords(limited)) expect(SUPPORTED.has(k), `${route}: keyword ${k}`).toBe(true);

      const answer = sample(limited);
      const g = gemini(() => answer);
      if (route === '/v1/turn') await g.adapter.generateTurn('system', []).catch(() => undefined);
      else if (route === '/v1/sentences') await g.adapter.generateSentences('system').catch(() => undefined);
      else await g.adapter.generateJson(task(route, zod, json)).catch(() => undefined);
      const sent = g.configs[0]!.generationConfig.responseSchema;
      for (const k of keywords(sent)) expect(SUPPORTED.has(k), `${route}: sent keyword ${k}`).toBe(true);
      for (const l of limits) {
        const node = schemaAt(sent as Json, l.path);
        if (node) expect(node[l.keyword], `${route} sent ${l.path}`).toBe(l.value);
      }
    });
  }

  it('the story schema carries the limits from stories/types.ts', () => {
    const story = JSON_ROUTES.find((r) => r.route === '/v1/story')!;
    const s = applyZodLimits(story.json, story.zod);
    expect(schemaAt(s, '/questions')).toMatchObject({ minItems: 1, maxItems: 6 });
    expect(schemaAt(s, '/questions[]/options')).toMatchObject({ minItems: 2, maxItems: 5 });
    expect(schemaAt(s, '/paragraphs[]/zh')).toMatchObject({ maxLength: 600 });
    expect(schemaAt(s, '/glosses')).toMatchObject({ maxItems: 6 });
  });

  it('harmless overruns are trimmed (7 questions → 6) instead of failing the route', () => {
    const story = JSON_ROUTES.find((r) => r.route === '/v1/story')!;
    const s = applyZodLimits(story.json, story.zod);
    const base = sample(s) as Json;
    const q = { q_zh: '他喝什麼？', q_en: 'What?', options: [{ zh: '茶', en: 'tea' }, { zh: '水', en: 'water' }], answer: 0 };
    const raw = { ...base, questions: Array.from({ length: 7 }, () => q) };
    expect(() => story.zod.parse(raw)).toThrow();
    expect((story.zod.parse(trimToLimits(raw, s)) as { questions: unknown[] }).questions).toHaveLength(6);
  });

  it('forcing the primary Gemini model to fail: every JSON route succeeds on GEMINI_MODEL_FALLBACK', async () => {
    for (const { route, zod, json } of JSON_ROUTES.filter((r) => r.route !== '/v1/turn' && r.route !== '/v1/sentences')) {
      const limited = applyZodLimits(json, zod);
      const primary = gemini(() => httpError(503, 'The model is overloaded'), 'gemini-primary');
      const fallback = gemini(() => sample(limited), 'gemini-fallback');
      const orch = createJsonOrchestrator(primary.adapter, fallback.adapter, new PromptCache(), quiet, { policy });
      const { result } = await orch.run(task(route, zod, json));
      expect(result.model, route).toBe('gemini-fallback');
      expect(primary.configs.length, route).toBe(2); // tried, then retried once
    }
  });

  it('Gemini errors get reasons: 429 → rate_limited (with retry-after), 401 → auth (never retried)', async () => {
    const r = JSON_ROUTES.find((x) => x.route === '/v1/story-check')!;
    const limited = applyZodLimits(r.json, r.zod);
    const authFail = gemini(() => httpError(401, 'API key not valid'), 'gemini-primary');
    const fallback = gemini(() => sample(limited), 'gemini-fallback');
    const orch = createJsonOrchestrator(authFail.adapter, fallback.adapter, new PromptCache(), quiet, { policy });
    const err = await orch.run(task(r.route, r.zod, r.json)).catch((e: unknown) => e);
    expect((err as ModelsFailedError).attempts).toEqual([{ model: 'gemini-primary', reason: 'auth' }]);
    expect(fallback.configs).toHaveLength(0);

    const limitedErr = Object.assign(httpError(429, 'Resource has been exhausted'), {
      errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
    });
    const waits: number[] = [];
    const rl = gemini(() => limitedErr, 'gemini-primary');
    const ok = gemini(() => sample(limited), 'gemini-fallback');
    const orch2 = createJsonOrchestrator(rl.adapter, ok.adapter, new PromptCache(), quiet, {
      policy: { backoffMs: 1000, maxWaitMs: 8000, sleep: async (ms) => void waits.push(ms) },
    });
    expect((await orch2.run(task(r.route, r.zod, r.json))).result.model).toBe('gemini-fallback');
    expect(waits).toEqual([7000]);
  });

  it('story-check runs on the checker model', async () => {
    const r = JSON_ROUTES.find((x) => x.route === '/v1/story-check')!;
    const limited = applyZodLimits(r.json, r.zod);
    const writer = gemini(() => sample(limited), 'gemini-writer');
    const checker = gemini(() => sample(limited), 'gemini-check');
    const orch = createJsonOrchestrator(writer.adapter, undefined, new PromptCache(), quiet, { checker: checker.adapter, policy });
    expect((await orch.run(task(r.route, r.zod, r.json), { checker: true })).result.model).toBe('gemini-check');
    expect(writer.configs).toHaveLength(0);
  });

  it('when every model fails, the 503 body names each model and why (no key, no prompt)', async () => {
    const r = JSON_ROUTES.find((x) => x.route === '/v1/story-check')!;
    const checker = gemini(() => httpError(429, 'rate limit'), 'gemini-check');
    const fallback = gemini(() => ({ nonsense: true }), 'gemini-fallback');
    const orch = createJsonOrchestrator(fallback.adapter, fallback.adapter, new PromptCache(), quiet, { checker: checker.adapter, policy });
    const err = await orch.run(task(r.route, r.zod, r.json), { checker: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelsFailedError);
    const body = failureBody(r.route, err);
    expect(body).toEqual({
      error: 'story_check_failed',
      attempts: [
        { model: 'gemini-check', reason: 'rate_limited' },
        { model: 'gemini-check', reason: 'rate_limited' },
        { model: 'gemini-fallback', reason: 'invalid_json' },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/test-key|system|user/);
  });
});
