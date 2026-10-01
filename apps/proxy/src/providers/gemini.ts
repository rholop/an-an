import { GoogleGenerativeAI } from '@google/generative-ai';
import { TurnResponseSchema, type TurnHistoryEntry } from '@anan/core';
import { TURN_RESPONSE_JSON_SCHEMA } from '../json-schema.js';
import { ProviderRetryableError, type ProviderAdapter, type ProviderResult } from './types.js';

const KICKOFF_MESSAGE = '（場景開始 — 請用你的角色說出開場白，並問第一個問題。）';

function toGeminiHistory(history: TurnHistoryEntry[]) {
  return history.map((h) => ({
    role: h.role === 'npc' ? ('model' as const) : ('user' as const),
    parts: [{ text: h.zh || h.en || '' }],
  }));
}

function isRetryable(err: unknown): 'rate_limit' | 'quota' | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  if (status === 429 || /429|rate.?limit/i.test(message)) return 'rate_limit';
  if (/RESOURCE_EXHAUSTED|quota/i.test(message)) return 'quota';
  return undefined;
}

export class GeminiAdapter implements ProviderAdapter {
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

    const geminiHistory = toGeminiHistory(history);
    const last = geminiHistory.at(-1);
    const chatHistory = geminiHistory.slice(0, -1);
    const messageToSend = last?.parts[0]?.text || KICKOFF_MESSAGE;

    let result;
    try {
      const chat = model.startChat({ history: chatHistory });
      result = await chat.sendMessage(messageToSend);
    } catch (err) {
      const retryable = isRetryable(err);
      if (retryable) throw new ProviderRetryableError(`Gemini ${retryable}`, retryable);
      throw err;
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
}
