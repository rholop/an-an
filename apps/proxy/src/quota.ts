// Phase 33: the Gemini free tier counts requests per day, per project, per model. This tracker
// remembers which models are out of quota (from the 429's QuotaFailure / RetryInfo details) so
// the orchestrator skips them without a wasted call, counts calls per model per quota day, and
// keeps a reserve of each model's known daily limit for the live app (batch scripts may not use
// it). Persisted to a small JSON file so it survives restarts and is shared with the scripts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextQuotaReset, quotaDayKey, type AiModelUsage, type AiUsage } from '@anan/core';

/** Live requests (the app) may use every call; batch requests (scripts) leave the reserve. */
export type AiPriority = 'live' | 'batch';

/** What a 429 says about the quota it hit. */
export interface QuotaDetails {
  /** A per-day quota (GenerateRequestsPerDay…): the model is out until the reset. */
  daily: boolean;
  /** A per-minute quota: a short wait and one retry. */
  perMinute: boolean;
  /** The quota's value (requests per day for a daily quota). */
  limit?: number;
  retryAfterMs?: number;
}

type Detail = {
  '@type'?: string;
  retryDelay?: string;
  violations?: Array<{ quotaId?: string; quotaMetric?: string; quotaValue?: string | number }>;
};

/** "50850s", "14h7m30.5s", "30.5s" → milliseconds. */
export function durationMs(text: string): number | undefined {
  const m = text.trim().match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.ceil(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000);
}

/** Reads a Gemini 429: the QuotaFailure violations and RetryInfo details (the SDK's
 * `errorDetails`), else the same facts from the message text. */
export function parseQuotaDetails(err: unknown): QuotaDetails {
  const message = err instanceof Error ? err.message : String(err);
  const details = ((err as { errorDetails?: unknown })?.errorDetails ?? []) as Detail[];
  const violations = Array.isArray(details)
    ? details.filter((d) => /QuotaFailure$/.test(d?.['@type'] ?? '')).flatMap((d) => d.violations ?? [])
    : [];
  const ids = violations.map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`);
  const daily = ids.some((id) => /PerDay/i.test(id)) || (/quota/i.test(message) && /per ?day|daily|PerDay/i.test(message));
  const perMinute = ids.some((id) => /PerMinute/i.test(id)) || /per ?minute|PerMinute/i.test(message);
  const dailyViolation = violations.find((v) => /PerDay/i.test(v.quotaId ?? '')) ?? violations[0];
  const fromDetail = Number(dailyViolation?.quotaValue);
  const fromMessage = Number(message.match(/limit:\s*(\d+)/)?.[1]);
  const limit = fromDetail > 0 ? fromDetail : fromMessage > 0 ? fromMessage : undefined;
  const delay = Array.isArray(details) ? details.find((d) => typeof d?.retryDelay === 'string')?.retryDelay : undefined;
  const retryAfterMs =
    (delay ? durationMs(delay) : undefined) ??
    (() => {
      const m = message.match(/retry in ([\d.hms]+?)\.?(?:\s|$)/i);
      return m ? durationMs(m[1]!) : undefined;
    })();
  return { daily, perMinute, ...(limit ? { limit } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

interface ModelState {
  /** The quota day these calls belong to. */
  day: string;
  calls: number;
  /** Out of quota (or unavailable) until this instant (ISO). */
  exhaustedUntil?: string;
  /** The daily limit learned from a 429. */
  limit?: number;
}

export interface QuotaState {
  version: 1;
  models: Record<string, ModelState>;
  /** Other per-day counts ("stories"). */
  counters: Record<string, { day: string; n: number }>;
}

const emptyState = (): QuotaState => ({ version: 1, models: {}, counters: {} });

/** Where the tracker keeps its state. */
export interface QuotaStore {
  read(): QuotaState | undefined;
  write(state: QuotaState): void;
}

export class MemoryQuotaStore implements QuotaStore {
  private text?: string;
  read() {
    return this.text ? (JSON.parse(this.text) as QuotaState) : undefined;
  }
  write(state: QuotaState) {
    this.text = JSON.stringify(state);
  }
}

/** A JSON file, written to a temp file and renamed. Read again before every decision, so the
 * proxy and a script running at the same time share one view of what's left. */
export class FileQuotaStore implements QuotaStore {
  constructor(readonly file: string) {}
  read(): QuotaState | undefined {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as QuotaState;
      return s && s.version === 1 && typeof s.models === 'object' ? { ...emptyState(), ...s } : undefined;
    } catch {
      return undefined;
    }
  }
  write(state: QuotaState): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, this.file);
  }
}

/** The default state file, shared by the proxy and the scripts: apps/proxy/quota-data/quota.json. */
export const DEFAULT_QUOTA_FILE = fileURLToPath(new URL('../quota-data/quota.json', import.meta.url));

/** "gemini-2.5-flash=20, gemini-2.5-flash-lite=1000" → { … }. */
export function parseLimits(text: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (text ?? '').split(',')) {
    const [model, n] = part.split('=').map((s) => s.trim());
    if (model && Number(n) > 0) out[model] = Math.floor(Number(n));
  }
  return out;
}

export interface QuotaOptions {
  store?: QuotaStore;
  /** Known daily request limits per model (config). A limit learned from a 429 fills the gaps. */
  limits?: Record<string, number>;
  /** Share of a known daily limit kept for the live app (default 0.3). */
  reserveShare?: number;
  /** At least this many calls are kept for the live app (default 5). */
  reserveMin?: number;
  now?: () => Date;
}

export type Blocked = 'exhausted' | 'reserved';

export class QuotaTracker {
  private readonly store: QuotaStore;
  private readonly limits: Record<string, number>;
  private readonly reserveShare: number;
  private readonly reserveMin: number;
  readonly now: () => Date;

  constructor(opts: QuotaOptions = {}) {
    this.store = opts.store ?? new MemoryQuotaStore();
    this.limits = opts.limits ?? {};
    this.reserveShare = opts.reserveShare ?? 0.3;
    this.reserveMin = opts.reserveMin ?? 5;
    this.now = opts.now ?? (() => new Date());
  }

  private load(): QuotaState {
    return this.store.read() ?? emptyState();
  }

  private change(fn: (s: QuotaState) => void): void {
    const s = this.load();
    fn(s);
    this.store.write(s);
  }

  /** A model's state for today (calls reset when the quota day changes). */
  private model(s: QuotaState, model: string): ModelState {
    const day = quotaDayKey(this.now());
    const m = s.models[model];
    if (!m) return (s.models[model] = { day, calls: 0 });
    if (m.day !== day) {
      m.day = day;
      m.calls = 0;
    }
    return m;
  }

  limitOf(model: string, s: QuotaState = this.load()): number | undefined {
    return this.limits[model] ?? s.models[model]?.limit;
  }

  /** Calls batch requests leave for the live app: the larger of the share and the minimum. */
  reserveOf(model: string, s: QuotaState = this.load()): number | undefined {
    const limit = this.limitOf(model, s);
    if (limit === undefined) return undefined;
    return Math.min(limit, Math.max(Math.ceil(limit * this.reserveShare), this.reserveMin));
  }

  /** Why `model` may not be called now at this priority, or undefined when it may. */
  blocked(model: string, priority: AiPriority = 'live'): Blocked | undefined {
    const s = this.load();
    const m = this.model(s, model);
    if (m.exhaustedUntil && Date.parse(m.exhaustedUntil) > this.now().getTime()) return 'exhausted';
    if (priority === 'batch') {
      const limit = this.limitOf(model, s);
      const reserve = this.reserveOf(model, s);
      if (limit !== undefined && reserve !== undefined && m.calls >= limit - reserve) return 'reserved';
    }
    return undefined;
  }

  /** One call made to `model` (counts toward today's use). */
  recordCall(model: string): void {
    this.change((s) => {
      this.model(s, model).calls++;
    });
  }

  /** A per-day 429: out until the retry delay has passed or the next midnight Pacific, whichever
   * comes first. A limit in the 429 is remembered (it sets the batch reserve from then on). */
  markExhausted(model: string, opts: { retryAfterMs?: number; limit?: number } = {}): void {
    const now = this.now();
    const reset = nextQuotaReset(now).getTime();
    const until = opts.retryAfterMs !== undefined ? Math.min(now.getTime() + opts.retryAfterMs, reset) : reset;
    this.change((s) => {
      const m = this.model(s, model);
      m.exhaustedUntil = new Date(until).toISOString();
      if (opts.limit) {
        m.limit = opts.limit;
        // the model said it is out: today's count is at least its limit
        m.calls = Math.max(m.calls, opts.limit);
      }
    });
  }

  /** When the first of `models` can be used again at this priority (now when one already can). */
  resetsAt(models: readonly string[], priority: AiPriority = 'live'): Date {
    const now = this.now();
    const s = this.load();
    let best = Infinity;
    for (const model of models) {
      const why = this.blocked(model, priority);
      if (!why) return now;
      const until = s.models[model]?.exhaustedUntil;
      const t = why === 'exhausted' && until ? Date.parse(until) : nextQuotaReset(now).getTime();
      best = Math.min(best, t);
    }
    return new Date(Number.isFinite(best) ? best : nextQuotaReset(now).getTime());
  }

  bump(counter: string): void {
    const day = quotaDayKey(this.now());
    this.change((s) => {
      const c = s.counters[counter];
      s.counters[counter] = c && c.day === day ? { day, n: c.n + 1 } : { day, n: 1 };
    });
  }

  count(counter: string): number {
    const c = this.load().counters[counter];
    return c && c.day === quotaDayKey(this.now()) ? c.n : 0;
  }

  /** Every model in `chains` (and any other model used today): calls, limit, reserve, exhausted. */
  usage(chains: Record<string, readonly string[]>): AiUsage {
    const now = this.now();
    const s = this.load();
    const day = quotaDayKey(now);
    const roles = new Map<string, string[]>();
    // `roles`: the roles that start on this model (it is a later link for the others)
    for (const [role, chain] of Object.entries(chains))
      chain.forEach((model, i) => roles.set(model, [...(roles.get(model) ?? []), ...(i === 0 ? [role] : [])]));
    for (const model of Object.keys(s.models)) if (!roles.has(model)) roles.set(model, []);
    const models: AiModelUsage[] = [...roles].map(([model, inRoles]) => {
      const m = s.models[model];
      const calls = m && m.day === day ? m.calls : 0;
      const until = m?.exhaustedUntil && Date.parse(m.exhaustedUntil) > now.getTime() ? m.exhaustedUntil : undefined;
      const limit = this.limitOf(model, s);
      const reserve = this.reserveOf(model, s);
      return {
        model,
        roles: inRoles,
        calls,
        ...(limit !== undefined ? { limit } : {}),
        ...(reserve !== undefined ? { reserve } : {}),
        exhausted: until !== undefined,
        ...(until ? { resetsAt: until } : {}),
      };
    });
    return { day, nextReset: nextQuotaReset(now).toISOString(), models, storiesToday: this.count('stories') };
  }
}
