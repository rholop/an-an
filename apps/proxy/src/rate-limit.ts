/**
 * Per-client (install-id header — CLAUDE.md §1: "No user accounts; an
 * install ID header is enough for rate limiting") request rate limiting and
 * daily token budget. In-memory, same single-process caveat as cache.ts.
 */
export interface RateLimitConfig {
  requestsPerMinute: number;
  dailyTokenBudget: number;
}

export type RateLimitCheck =
  | { allowed: true }
  | { allowed: false; reason: 'rate_limit'; retryAfterMs: number }
  | { allowed: false; reason: 'daily_budget' };

interface ClientState {
  requestTimestamps: number[];
  tokensUsedToday: number;
  dayKey: string;
}

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class RateLimiter {
  private readonly clients = new Map<string, ClientState>();

  constructor(private readonly config: RateLimitConfig) {}

  private getOrCreate(installId: string, now: Date): ClientState {
    const dayKey = utcDayKey(now);
    const existing = this.clients.get(installId);
    if (existing && existing.dayKey === dayKey) return existing;
    const fresh: ClientState = { requestTimestamps: [], tokensUsedToday: 0, dayKey };
    this.clients.set(installId, fresh);
    return fresh;
  }

  /** Call before handling a request. Does not itself record token usage —
   * call recordUsage() once the actual token count is known. */
  check(installId: string, now: Date = new Date()): RateLimitCheck {
    const state = this.getOrCreate(installId, now);

    if (state.tokensUsedToday >= this.config.dailyTokenBudget) {
      return { allowed: false, reason: 'daily_budget' };
    }

    const windowStart = now.getTime() - 60_000;
    state.requestTimestamps = state.requestTimestamps.filter((t) => t > windowStart);
    if (state.requestTimestamps.length >= this.config.requestsPerMinute) {
      const oldestInWindow = state.requestTimestamps[0]!;
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfterMs: oldestInWindow + 60_000 - now.getTime(),
      };
    }

    state.requestTimestamps.push(now.getTime());
    return { allowed: true };
  }

  recordUsage(installId: string, tokens: number, now: Date = new Date()): void {
    const state = this.getOrCreate(installId, now);
    state.tokensUsedToday += tokens;
  }

  remainingBudget(installId: string, now: Date = new Date()): number {
    const state = this.getOrCreate(installId, now);
    return Math.max(0, this.config.dailyTokenBudget - state.tokensUsedToday);
  }
}
