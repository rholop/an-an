import { GoogleGenerativeAI } from '@google/generative-ai';
import { SentenceGenResponseSchema, TurnResponseSchema, type TurnHistoryEntry } from '@anan/core';
import { SENTENCE_GEN_RESPONSE_JSON_SCHEMA, TURN_RESPONSE_JSON_SCHEMA } from '../json-schema.js';
import {
  ProviderRetryableError,
  type ProviderAdapter,
  type JsonTaskAdapter,
  type JsonTaskRequest,
  type JsonTaskResult,
  type ProviderResult,
  type SentenceGenAdapter,
  type SentenceProviderResult,
} from './types.js';

const KICKOFF_MESSAGE = '（場景開始 — 請用你的角色說出開場白，並問第一個問題。）';
const SENTENCE_GEN_KICKOFF = '請開始生成例句。';

/** Gemini rejects a chat whose first content isn't role 'user'. A history that
 * opens with the NPC's scenario opener gets a short user turn in front of it. */
export const LEARNER_ARRIVES_MESSAGE = '(The learner arrives.)';

function toGeminiHistory(history: TurnHistoryEntry[]) {
  const contents = history.map((h) => ({
    role: h.role === 'npc' ? ('model' as const) : ('user' as const),
    parts: [{ text: h.zh || h.en || '' }],
  }));
  if (contents[0]?.role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: LEARNER_ARRIVES_MESSAGE }] });
  }
  return contents;
}

/** Splits the history into the `startChat` history and the message to send. */
export function buildGeminiChat(history: TurnHistoryEntry[]) {
  const contents = toGeminiHistory(history);
  const last = contents.at(-1);
  return {
    chatHistory: contents.slice(0, -1),
    message: last?.parts[0]?.text || KICKOFF_MESSAGE,
  };
}

function isRetryable(err: unknown): 'rate_limit' | 'quota' | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  if (status === 429 || /429|rate.?limit/i.test(message)) return 'rate_limit';
  if (/RESOURCE_EXHAUSTED|quota/i.test(message)) return 'quota';
  return undefined;
}

/** Any Gemini request failure is fallback-worthy; rate limit / quota keep
 * their specific reason, everything else is a 'request_error'. */
function toProviderError(err: unknown): ProviderRetryableError {
  const retryable = isRetryable(err);
  if (retryable) return new ProviderRetryableError(`Gemini ${retryable}`, retryable);
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderRetryableError(`Gemini request error: ${message}`, 'request_error');
}

export class GeminiAdapter implements ProviderAdapter, SentenceGenAdapter, JsonTaskAdapter {
  readonly name = 'gemini' as const;
  private readonly client: GoogleGenerativeAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateTurn(systemPrompt: string, history: TurnHistoryEntry[]): Promise<ProviderResult> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: TURN_RESPONSE_JSON_SCHEMA as any,
      },
    });

    const { chatHistory, message: messageToSend } = buildGeminiChat(history);

    let result;
    try {
      const chat = model.startChat({ history: chatHistory });
      result = await chat.sendMessage(messageToSend);
    } catch (err) {
      throw toProviderError(err);
    }

    const text = result.response.text();
    let parsed;
    try {
      parsed = TurnResponseSchema.parse(JSON.parse(text));
    } catch (err) {
      throw new ProviderRetryableError(
        `Gemini returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    const usage = result.response.usageMetadata;
    return {
      response: parsed,
      provider: 'gemini',
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }

  async generateSentences(systemPrompt: string): Promise<SentenceProviderResult> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: SENTENCE_GEN_RESPONSE_JSON_SCHEMA as any,
      },
    });

    let result;
    try {
      result = await model.generateContent(SENTENCE_GEN_KICKOFF);
    } catch (err) {
      throw toProviderError(err);
    }

    const text = result.response.text();
    let parsed;
    try {
      parsed = SentenceGenResponseSchema.parse(JSON.parse(text));
    } catch (err) {
      throw new ProviderRetryableError(
        `Gemini returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    const usage = result.response.usageMetadata;
    return {
      response: parsed,
      provider: 'gemini',
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }

  async generateJson<T>(req: JsonTaskRequest<T>): Promise<JsonTaskResult<T>> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: req.systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: req.jsonSchema as any,
      },
    });

    let result;
    try {
      result = await model.generateContent(req.userMessage);
    } catch (err) {
      throw toProviderError(err);
    }

    let parsed: T;
    try {
      parsed = req.parse(JSON.parse(result.response.text()));
    } catch (err) {
      throw new ProviderRetryableError(
        `Gemini returned invalid JSON for ${req.task}: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    const usage = result.response.usageMetadata;
    return {
      response: parsed,
      provider: 'gemini',
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }
}
