import OpenAI from 'openai';
import { SentenceGenResponseSchema, TurnResponseSchema, type TurnHistoryEntry } from '@anan/core';
import { SENTENCE_GEN_RESPONSE_JSON_SCHEMA, TURN_RESPONSE_JSON_SCHEMA } from '../json-schema.js';
import { applyZodLimits, trimToLimits } from '../zod-limits.js';

const TURN_SCHEMA = applyZodLimits(TURN_RESPONSE_JSON_SCHEMA, TurnResponseSchema);
const SENTENCE_SCHEMA = applyZodLimits(
  SENTENCE_GEN_RESPONSE_JSON_SCHEMA,
  SentenceGenResponseSchema,
);
import {
  ProviderRetryableError,
  schemaName,
  type ProviderAdapter,
  type JsonTaskAdapter,
  type JsonTaskRequest,
  type JsonTaskResult,
  type ProviderResult,
  type SentenceGenAdapter,
  type SentenceProviderResult,
} from './types.js';

const SENTENCE_GEN_KICKOFF = 'Generate the sentences now.';

function toOpenAiMessages(
  systemPrompt: string,
  history: TurnHistoryEntry[],
): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map((h): OpenAI.ChatCompletionMessageParam => ({
      role: h.role === 'npc' ? 'assistant' : 'user',
      content: h.zh || h.en || '',
    })),
  ];
}

/**
 * Phase 25: every OpenAI request failure falls back to the other provider (as Gemini's do), with
 * a reason the 502 body can name. Before this a 400 (e.g. a bad schema name) was a plain Error,
 * so the route 502'd without ever trying Gemini.
 */
export function toProviderError(err: unknown): ProviderRetryableError {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota/i.test(message))
    return new ProviderRetryableError('OpenAI quota', 'quota');
  if (status === 429) return new ProviderRetryableError('OpenAI rate_limit', 'rate_limit');
  if (status === 401 || status === 403) return new ProviderRetryableError('OpenAI auth', 'auth');
  if (status !== undefined && status >= 400 && status < 500)
    return new ProviderRetryableError(`OpenAI bad request: ${message}`, 'bad_request');
  if (status !== undefined && status >= 500)
    return new ProviderRetryableError(`OpenAI server error: ${message}`, 'server_error');
  return new ProviderRetryableError(`OpenAI request error: ${message}`, 'request_error');
}

export class OpenAiAdapter implements ProviderAdapter, SentenceGenAdapter, JsonTaskAdapter {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async generateTurn(systemPrompt: string, history: TurnHistoryEntry[]): Promise<ProviderResult> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAiMessages(systemPrompt, history),
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'turn_response', schema: TURN_SCHEMA, strict: false },
        },
      });
    } catch (err) {
      throw toProviderError(err);
    }

    const text = completion.choices[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = TurnResponseSchema.parse(trimToLimits(JSON.parse(text), TURN_SCHEMA));
    } catch (err) {
      throw new ProviderRetryableError(
        `OpenAI returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    return {
      response: parsed,
      provider: 'openai',
      model: this.model,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  async generateSentences(systemPrompt: string): Promise<SentenceProviderResult> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: SENTENCE_GEN_KICKOFF },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'sentence_gen_response',
            schema: SENTENCE_SCHEMA,
            strict: false,
          },
        },
      });
    } catch (err) {
      throw toProviderError(err);
    }

    const text = completion.choices[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = SentenceGenResponseSchema.parse(trimToLimits(JSON.parse(text), SENTENCE_SCHEMA));
    } catch (err) {
      throw new ProviderRetryableError(
        `OpenAI returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    return {
      response: parsed,
      provider: 'openai',
      model: this.model,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  async generateJson<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userMessage },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName(req.task),
            schema: req.jsonSchema as Record<string, unknown>,
            strict: false,
          },
        },
      });
    } catch (err) {
      throw toProviderError(err);
    }

    let parsed: T;
    try {
      parsed = req.parse(JSON.parse(completion.choices[0]?.message?.content ?? ''));
    } catch (err) {
      throw new ProviderRetryableError(
        `OpenAI returned invalid JSON for ${req.task}: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    return {
      response: parsed,
      provider: 'openai',
      model: this.model,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}
