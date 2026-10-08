import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('OPENAI_ENABLED (Phase 25: OpenAI is never called unless enabled)', () => {
  it('is off by default, even with a key', () => {
    expect(loadEnv({ OPENAI_API_KEY: 'sk-x' }).OPENAI_ENABLED).toBe(false);
  });
  it('turns on only with 1 / true', () => {
    expect(loadEnv({ OPENAI_ENABLED: '1' }).OPENAI_ENABLED).toBe(true);
    expect(loadEnv({ OPENAI_ENABLED: 'true' }).OPENAI_ENABLED).toBe(true);
    expect(loadEnv({ OPENAI_ENABLED: '0' }).OPENAI_ENABLED).toBe(false);
  });
});
