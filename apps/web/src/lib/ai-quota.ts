// Phase 33: the free Gemini quota as the app sees it. When the proxy answers 503 quota_exhausted
// (every model of a chain is out until `resetsAt`), the app says so in plain words and background
// story writing waits until then. Settings → AI usage reads GET /v1/ai-usage.
import { AiUsageSchema, QuotaExhaustedBodySchema, type AiUsage } from '@anan/core';
import { authHeaders, proxyBase } from './api.js';
import { AI_QUOTA_USED, aiQuotaUsedUntil } from './labels.js';
import { currentTimeZone } from './review-settings.js';

const PAUSE_KEY = 'anan.aiQuotaPausedUntil';

/** When the quota was last seen used up, until when (ms), or 0. */
let pausedUntil = (() => {
  try {
    return Number(localStorage.getItem(PAUSE_KEY)) || 0;
  } catch {
    return 0;
  }
})();

/** The proxy said the free quota is used up until `resetsAt`. */
export function noteQuotaExhausted(resetsAt: Date): void {
  pausedUntil = Math.max(pausedUntil, resetsAt.getTime());
  try {
    localStorage.setItem(PAUSE_KEY, String(pausedUntil));
  } catch {
    // private mode: kept for this page only
  }
}

/** Until when AI work that nobody asked for (background stories) waits, or undefined. */
export function aiPausedUntil(now: Date = new Date()): Date | undefined {
  return pausedUntil > now.getTime() ? new Date(pausedUntil) : undefined;
}

/** The `resetsAt` of a 503 quota_exhausted body, or undefined for any other body. */
export function quotaResetFrom(status: number, body: unknown): Date | undefined {
  if (status !== 503) return undefined;
  const parsed = QuotaExhaustedBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  const at = new Date(parsed.data.resetsAt);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** What to show for a quota failure: with the reset time when the proxy gave one. */
export function quotaText(resetsAt: Date | undefined, now: Date = new Date()): string {
  return resetsAt ? aiQuotaUsedUntil(resetsAt, now, currentTimeZone()) : AI_QUOTA_USED;
}

/** Settings → AI usage. Null when the proxy can't be reached or doesn't track the quota. */
export async function fetchAiUsage(): Promise<AiUsage | null> {
  try {
    const res = await fetch(`${proxyBase()}/v1/ai-usage`, { headers: authHeaders() });
    if (!res.ok) return null;
    const parsed = AiUsageSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
