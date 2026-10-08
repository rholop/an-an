import { GoogleGenerativeAI } from '@google/generative-ai';
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

/** Seconds from a 429: the RetryInfo detail ("30s") or "Please retry in 30.5s" in the message. */
function retryAfterMs(err: unknown): number | undefined {
  const details = (err as { errorDetails?: Array<{ retryDelay?: string }> })?.errorDetails;
  const delay = details?.find((d) => typeof d?.retryDelay === 'string')?.retryDelay;
  const m = (delay ?? (err instanceof Error ? err.message : String(err))).match(/(\d+(?:\.\d+)?)\s*s\b/);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

/** Phase 25: every Gemini failure gets a reason. `auth` is never retried; the rest may be. */
export function toProviderError(err: unknown): ProviderRetryableError {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  const short = message.slice(0, 300);
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message))
    return new ProviderRetryableError(`Gemini auth: ${short}`, 'auth');
  if (/quota/i.test(message) && /per day|daily|PerDay/i.test(message))
    return new ProviderRetryableError(`Gemini quota: ${short}`, 'quota', retryAfterMs(err));
  if (status === 429 || /\b429\b|rate.?limit|RESOURCE_EXHAUSTED|quota/i.test(message))
    return new ProviderRetryableError(`Gemini rate limited: ${short}`, 'rate_limited', retryAfterMs(err));
  if ((err as { name?: string })?.name === 'AbortError' || /timed? ?out|deadline|ETIMEDOUT/i.test(message))
    return new ProviderRetryableError(`Gemini timeout: ${short}`, 'timeout');
  if ((status !== undefined && status >= 500) || /\b50[0-9]\b|INTERNAL|UNAVAILABLE|overloaded/i.test(message))
    return new ProviderRetryableError(`Gemini server error: ${short}`, 'server_error');
  if ((status !== undefined && status >= 400) || /\b400\b|INVALID_ARGUMENT/i.test(message))
    return new ProviderRetryableError(`Gemini bad request: ${short}`, 'bad_request');
  return new ProviderRetryableError(`Gemini request error: ${short}`, 'request_error');
}

/** One model call never hangs a request: past this it counts as a timeout. */
export const GEMINI_TIMEOUT_MS = 25_000;

export class GeminiAdapter implements ProviderAdapter, SentenceGenAdapter, JsonTaskAdapter {
  private readonly client: GoogleGenerativeAI;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number = GEMINI_TIMEOUT_MS,
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
        responseSchema: TURN_SCHEMA as any,
      },
    }, { timeout: this.timeoutMs });

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
      parsed = TurnResponseSchema.parse(trimToLimits(JSON.parse(text), TURN_SCHEMA));
    } catch (err) {
      throw new ProviderRetryableError(
        `Gemini returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    const usage = result.response.usageMetadata;
    return {
      response: parsed,
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
        responseSchema: SENTENCE_SCHEMA as any,
      },
    }, { timeout: this.timeoutMs });

    let result;
    try {
      result = await model.generateContent(SENTENCE_GEN_KICKOFF);
    } catch (err) {
      throw toProviderError(err);
    }

    const text = result.response.text();
    let parsed;
    try {
      parsed = SentenceGenResponseSchema.parse(trimToLimits(JSON.parse(text), SENTENCE_SCHEMA));
    } catch (err) {
      throw new ProviderRetryableError(
        `Gemini returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_json',
      );
    }

    const usage = result.response.usageMetadata;
    return {
      response: parsed,
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
    }, { timeout: this.timeoutMs });

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
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }
}
