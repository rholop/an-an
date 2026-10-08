import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnHistoryEntry } from '@anan/core';
import { fakeTurnResponse } from './fake.js';
import { ProviderRetryableError } from './types.js';

const startChat = vi.fn();
const sendMessage = vi.fn();

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { startChat, generateContent: sendMessage };
    }
  },
}));

const { GeminiAdapter, LEARNER_ARRIVES_MESSAGE, buildGeminiChat, toProviderError } = await import('./gemini.js');

const npcOpener: TurnHistoryEntry = { role: 'npc', zh: '歡迎光臨！要喝什麼？' };
const learnerReply: TurnHistoryEntry = { role: 'learner', zh: '我要一杯珍珠奶茶' };

describe('buildGeminiChat', () => {
  it('prepends a user turn when the history starts with an NPC turn', () => {
    const { chatHistory, message } = buildGeminiChat([npcOpener, learnerReply]);
    expect(chatHistory).toEqual([
      { role: 'user', parts: [{ text: LEARNER_ARRIVES_MESSAGE }] },
      { role: 'model', parts: [{ text: '歡迎光臨！要喝什麼？' }] },
    ]);
    expect(message).toBe('我要一杯珍珠奶茶');
  });

  it('leaves a history that already starts with the learner untouched', () => {
    const { chatHistory } = buildGeminiChat([learnerReply, npcOpener, learnerReply]);
    expect(chatHistory[0]?.role).toBe('user');
    expect(chatHistory[0]?.parts[0]?.text).toBe('我要一杯珍珠奶茶');
    expect(chatHistory).toHaveLength(2);
  });

  it('uses the kickoff message for an empty history', () => {
    const { chatHistory, message } = buildGeminiChat([]);
    expect(chatHistory).toEqual([]);
    expect(message).toContain('場景開始');
  });
});

describe('GeminiAdapter', () => {
  beforeEach(() => {
    startChat.mockReset();
    sendMessage.mockReset();
  });

  it('starts the chat with a user-role first entry when the history starts with an NPC turn', async () => {
    const send = vi.fn().mockResolvedValue({
      response: { text: () => JSON.stringify(fakeTurnResponse()), usageMetadata: {} },
    });
    startChat.mockReturnValue({ sendMessage: send });

    await new GeminiAdapter('key', 'gemini-test').generateTurn('sys', [npcOpener, learnerReply]);

    const { history } = startChat.mock.calls[0]![0] as { history: { role: string }[] };
    expect(history[0]?.role).toBe('user');
    expect(send).toHaveBeenCalledWith('我要一杯珍珠奶茶');
  });

  it('gives every Gemini failure a reason (Phase 25)', async () => {
    const cases: Array<[Error, string]> = [
      [new Error('[400 Bad Request] invalid argument'), 'bad_request'],
      [Object.assign(new Error('[429 Too Many Requests] Resource has been exhausted'), { status: 429 }), 'rate_limited'],
      [new Error('[503 Service Unavailable] The model is overloaded'), 'server_error'],
      [Object.assign(new Error('[403 Forbidden] API key not valid'), { status: 403 }), 'auth'],
      [Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'timeout'],
      [new Error('fetch failed'), 'request_error'],
    ];
    for (const [thrown, reason] of cases) {
      startChat.mockReturnValue({ sendMessage: vi.fn().mockRejectedValue(thrown) });
      const err = await new GeminiAdapter('key', 'gemini-test')
        .generateTurn('sys', [learnerReply])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderRetryableError);
      expect((err as ProviderRetryableError).reason, thrown.message).toBe(reason);
    }
  });

  it("reads a 429's retry delay", () => {
    const err = Object.assign(new Error('[429] quota'), {
      status: 429,
      errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }],
    });
    expect(toProviderError(err)).toMatchObject({ reason: 'rate_limited', retryAfterMs: 12_000 });
  });
});
