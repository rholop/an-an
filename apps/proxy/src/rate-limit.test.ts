import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('RateLimiter: per-minute request limit', () => {
  it('allows requests up to the configured per-minute limit', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 3, dailyTokenBudget: 1_000_000 });
    expect(limiter.check('client-a', NOW)).toEqual({ allowed: true });
    expect(limiter.check('client-a', NOW)).toEqual({ allowed: true });
    expect(limiter.check('client-a', NOW)).toEqual({ allowed: true });
    const fourth = limiter.check('client-a', NOW);
    expect(fourth.allowed).toBe(false);
    expect(fourth.allowed === false && fourth.reason).toBe('rate_limit');
  });

  it('tracks each install id independently', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 1, dailyTokenBudget: 1_000_000 });
    expect(limiter.check('client-a', NOW).allowed).toBe(true);
    expect(limiter.check('client-b', NOW).allowed).toBe(true);
    expect(limiter.check('client-a', NOW).allowed).toBe(false);
  });

  it('allows a new request once the 60s window has rolled past', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 1, dailyTokenBudget: 1_000_000 });
    expect(limiter.check('client-a', NOW).allowed).toBe(true);
    expect(limiter.check('client-a', NOW).allowed).toBe(false);
    const later = new Date(NOW.getTime() + 61_000);
    expect(limiter.check('client-a', later).allowed).toBe(true);
  });
});

describe('RateLimiter: daily token budget', () => {
  it('blocks once the daily token budget is exhausted', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 100 });
    limiter.recordUsage('client-a', 100, NOW);
    const result = limiter.check('client-a', NOW);
    expect(result).toEqual({ allowed: false, reason: 'daily_budget' });
  });

  it('resets the budget on a new UTC day', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 100 });
    limiter.recordUsage('client-a', 100, NOW);
    expect(limiter.check('client-a', NOW).allowed).toBe(false);

    const nextDay = new Date('2026-01-02T00:00:00Z');
    expect(limiter.check('client-a', nextDay).allowed).toBe(true);
  });

  it('remainingBudget reflects usage so far today', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 1000 });
    limiter.recordUsage('client-a', 300, NOW);
    expect(limiter.remainingBudget('client-a', NOW)).toBe(700);
  });

  it('remainingBudget never goes negative', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, dailyTokenBudget: 100 });
    limiter.recordUsage('client-a', 500, NOW);
    expect(limiter.remainingBudget('client-a', NOW)).toBe(0);
  });
});
