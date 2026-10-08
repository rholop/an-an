import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('env (Phase 25: Gemini only)', () => {
  it('has a fallback and a checker Gemini model, configurable per task', () => {
    const env = loadEnv({ GEMINI_API_KEY: 'k' });
    expect(env.GEMINI_MODEL_FALLBACK).toMatch(/^gemini-/);
    expect(env.GEMINI_MODEL_CHECK).toMatch(/^gemini-/);
    expect(env.GEMINI_MODEL_FALLBACK).not.toBe(env.GEMINI_MODEL_TURN);
    expect(loadEnv({ GEMINI_MODEL_FALLBACK: 'gemini-x' }).GEMINI_MODEL_FALLBACK).toBe('gemini-x');
  });
});
