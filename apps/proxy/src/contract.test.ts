import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { PromptCache } from './cache.js';
import { JSON_ROUTES } from './json-routes.js';
import { createJsonOrchestrator } from './orchestrator.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAiAdapter } from './providers/openai.js';
import { ProvidersFailedError, schemaName, type JsonTaskRequest } from './providers/types.js';
import { failureBody } from './app.js';
import { applyZodLimits, schemaAt, trimToLimits, zodLimits } from './zod-limits.js';

/**
 * Phase 25: contract tests for every JSON route against the REAL adapters (no network: the SDK
 * clients are swapped for recorders). The story 502 came from a request OpenAI rejects
 * (json_schema.name '/v1/story') that no fake-adapter test could see.
 */

type Json = Record<string, unknown>;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Keywords both Gemini's responseSchema and OpenAI's json_schema accept. */
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

function openAi(
  respond: (req: { response_format: { json_schema: { name: string; schema: Json } } }) => unknown,
) {
  const adapter = new OpenAiAdapter('test-key', 'gpt-test');
  const calls: Array<{ response_format: { json_schema: { name: string; schema: Json } } }> = [];
  (adapter as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (req: (typeof calls)[number]) => {
          calls.push(req);
          const r = respond(req);
          if (r instanceof Error) throw r;
          return {
            choices: [{ message: { content: JSON.stringify(r) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  return { adapter, calls };
}

function gemini(respond: (cfg: { generationConfig: { responseSchema: Json } }) => unknown) {
  const adapter = new GeminiAdapter('test-key', 'gemini-test');
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

describe('JSON route contracts (Phase 25)', () => {
  it('the schema name is always one OpenAI accepts', () => {
    expect(schemaName('/v1/story-check')).toBe('v1_story_check');
    for (const r of JSON_ROUTES) expect(schemaName(r.route)).toMatch(NAME);
  });

  for (const { route, zod, json } of JSON_ROUTES) {
    it(`${route}: the real OpenAI and Gemini requests are valid and carry the zod limits`, async () => {
      const limits = zodLimits(zod);
      const limited = applyZodLimits(json, zod);
      // every zod limit is in the schema the model sees
      for (const l of limits) {
        const node = schemaAt(limited, l.path);
        if (node) expect(node[l.keyword], `${route} ${l.path} ${l.keyword}`).toBe(l.value);
      }
      for (const k of keywords(limited))
        expect(SUPPORTED.has(k), `${route}: keyword ${k}`).toBe(true);

      const answer = sample(limited);
      const o = openAi(() => answer);
      const g = gemini(() => answer);
      if (route === '/v1/turn') {
        await o.adapter.generateTurn('system', []).catch(() => undefined);
        await g.adapter.generateTurn('system', []).catch(() => undefined);
      } else if (route === '/v1/sentences') {
        await o.adapter.generateSentences('system').catch(() => undefined);
        await g.adapter.generateSentences('system').catch(() => undefined);
      } else {
        await o.adapter.generateJson(task(route, zod, json)).catch(() => undefined);
        await g.adapter.generateJson(task(route, zod, json)).catch(() => undefined);
      }
      const sentOpenAi = o.calls[0]!.response_format.json_schema;
      expect(sentOpenAi.name).toMatch(NAME);
      const sentGemini = g.configs[0]!.generationConfig.responseSchema;
      for (const sent of [sentOpenAi.schema, sentGemini]) {
        for (const k of keywords(sent))
          expect(SUPPORTED.has(k), `${route}: sent keyword ${k}`).toBe(true);
        for (const l of limits) {
          const node = schemaAt(sent as Json, l.path);
          if (node) expect(node[l.keyword], `${route} sent ${l.path}`).toBe(l.value);
        }
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
    const q = {
      q_zh: '他喝什麼？',
      q_en: 'What?',
      options: [
        { zh: '茶', en: 'tea' },
        { zh: '水', en: 'water' },
      ],
      answer: 0,
    };
    const raw = { ...base, questions: Array.from({ length: 7 }, () => q) };
    expect(() => story.zod.parse(raw)).toThrow();
    expect(
      (story.zod.parse(trimToLimits(raw, s)) as { questions: unknown[] }).questions,
    ).toHaveLength(6);
  });

  it('forcing Gemini to fail: every JSON route succeeds via OpenAI', async () => {
    for (const { route, zod, json } of JSON_ROUTES.filter(
      (r) => r.route !== '/v1/turn' && r.route !== '/v1/sentences',
    )) {
      const limited = applyZodLimits(json, zod);
      const o = openAi(() => sample(limited));
      const g = gemini(() => httpError(500, 'boom'));
      const orch = createJsonOrchestrator(g.adapter, o.adapter, new PromptCache(), () => undefined);
      const { result } = await orch.run(task(route, zod, json));
      expect(result.provider, route).toBe('openai');
    }
  });

  it('OpenAI chosen first (story-check avoids Gemini) and rejecting the request: Gemini answers', async () => {
    const r = JSON_ROUTES.find((x) => x.route === '/v1/story-check')!;
    const limited = applyZodLimits(r.json, r.zod);
    const o = openAi(() => httpError(400, "Invalid 'response_format.json_schema.name'"));
    const g = gemini(() => sample(limited));
    const orch = createJsonOrchestrator(g.adapter, o.adapter, new PromptCache(), () => undefined);
    const { result } = await orch.run(task(r.route, r.zod, r.json), { avoidProvider: 'gemini' });
    expect(o.calls).toHaveLength(1);
    expect(result.provider).toBe('gemini');
  });

  it('when both fail, the 502 body names each provider and why (no key, no prompt)', async () => {
    const r = JSON_ROUTES.find((x) => x.route === '/v1/story-check')!;
    const o = openAi(() => httpError(400, 'bad'));
    const g = gemini(() => ({ nonsense: true }));
    const orch = createJsonOrchestrator(g.adapter, o.adapter, new PromptCache(), () => undefined);
    const err = await orch
      .run(task(r.route, r.zod, r.json), { avoidProvider: 'gemini' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvidersFailedError);
    const body = failureBody(r.route, err);
    expect(body).toEqual({
      error: 'story_check_failed',
      providers: [
        { name: 'openai', reason: 'bad_request' },
        { name: 'gemini', reason: 'invalid_json' },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/test-key|system|user/);
  });
});
