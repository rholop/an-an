import OpenAI from 'openai';
import { TurnResponseSchema, type TurnHistoryEntry } from '@anan/core';
import { TURN_RESPONSE_JSON_SCHEMA } from '../json-schema.js';
import { ProviderRetryableError, type ProviderAdapter, type ProviderResult } from './types.js';

function toOpenAiMessages(systemPrompt: string, history: TurnHistoryEntry[]): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map(
      (h): OpenAI.ChatCompletionMessageParam => ({
        role: h.role === 'npc' ? 'assistant' : 'user',
        content: h.zh || h.en || '',
      }),
    ),
  ];
}

function isRetryable(err: unknown): 'rate_limit' | 'quota' | undefined {
  const status = (err as { status?: number })?.status;
  if (status === 429) return 'rate_limit';
  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|quota/i.test(message)) return 'quota';
  return undefined;
}

export class OpenAiAdapter implements ProviderAdapter {
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
          json_schema: { name: 'turn_response', schema: TURN_RESPONSE_JSON_SCHEMA, strict: false },
        },
      });
    } catch (err) {
      const retryable = isRetryable(err);
      if (retryable) throw new ProviderRetryableError(`OpenAI ${retryable}`, retryable);
      throw err;
    }

    const text = completion.choices[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = TurnResponseSchema.parse(JSON.parse(text));
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
}
