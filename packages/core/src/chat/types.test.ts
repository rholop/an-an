import { describe, expect, it } from 'vitest';
import { TurnRequestSchema, TurnResponseSchema } from './types.js';

describe('TurnRequestSchema', () => {
  const valid = {
    scenarioId: 'tea-shop',
    npcId: 'ayi',
    history: [{ role: 'npc', zh: '歡迎光臨！' }],
    learnerLevel: 'N2',
    vocab: { knownSample: ['我'], due: ['喝'], targets: ['少冰'], allowedExtras: ['珍珠奶茶'] },
    scaffolding: 'high',
    englishFallback: false,
  };

  it('accepts a well-formed request', () => {
    expect(TurnRequestSchema.parse(valid)).toBeTruthy();
  });

  it('rejects an invalid learnerLevel', () => {
    expect(() => TurnRequestSchema.parse({ ...valid, learnerLevel: 'L7' })).toThrow();
  });

  it('rejects an invalid scaffolding value', () => {
    expect(() => TurnRequestSchema.parse({ ...valid, scaffolding: 'none' })).toThrow();
  });

  it('rejects a history entry with an invalid role', () => {
    expect(() => TurnRequestSchema.parse({ ...valid, history: [{ role: 'bot', zh: '你好' }] })).toThrow();
  });

  it('allows an optional `en` on history entries but does not require it', () => {
    const withEn = { ...valid, history: [{ role: 'learner', zh: '我要一杯奶茶', en: 'I want a milk tea' }] };
    expect(TurnRequestSchema.parse(withEn)).toBeTruthy();
  });
});

describe('TurnResponseSchema', () => {
  const valid = {
    reply_zh: '好的，要不要加珍珠？',
    reply_en: 'Okay, do you want pearls?',
    tokens: [{ text: '好的' }, { text: '要不要', lemma: '要不要' }],
    targets_used: ['珍珠'],
    suggested_replies: [{ zh: '要', en: 'yes' }],
    goal_progress: [{ step: 'order-drink', done: false }],
  };

  it('accepts a well-formed response', () => {
    expect(TurnResponseSchema.parse(valid)).toBeTruthy();
  });

  it('recast_zh is optional', () => {
    expect(TurnResponseSchema.parse(valid).recast_zh).toBeUndefined();
    expect(TurnResponseSchema.parse({ ...valid, recast_zh: '我要一杯奶茶。' }).recast_zh).toBe('我要一杯奶茶。');
  });

  it('rejects a response missing a required field', () => {
    const { reply_zh: _reply_zh, ...missing } = valid;
    expect(() => TurnResponseSchema.parse(missing)).toThrow();
  });

  it('rejects malformed JSON shapes from a misbehaving LLM (wrong type for tokens)', () => {
    expect(() => TurnResponseSchema.parse({ ...valid, tokens: 'not an array' })).toThrow();
  });
});
