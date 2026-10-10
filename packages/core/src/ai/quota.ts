// Phase 33: the Gemini free tier counts requests per model per day and resets at midnight
// Pacific time. What the proxy, the scripts and the web app say about it. Pure: `now` is injected.
import { z } from 'zod';
import { zonedDay, zonedEndOfDay, zonedParts } from '../progress/time.js';

/** The free tier's day: it resets at midnight Pacific time. */
export const FREE_TIER_RESET_ZONE = 'America/Los_Angeles';

/** The quota day of `now`, "YYYY-MM-DD" in Pacific time (calls are counted per this day). */
export function quotaDayKey(now: Date): string {
  return zonedDay(now, FREE_TIER_RESET_ZONE);
}

/** The next free-tier reset (the next midnight Pacific) after `now`. */
export function nextQuotaReset(now: Date): Date {
  return zonedEndOfDay(now, FREE_TIER_RESET_ZONE);
}

/** 503 body when every model of a role's chain is out of free quota (or kept for the live app). */
export const QuotaExhaustedBodySchema = z.object({
  error: z.literal('quota_exhausted'),
  /** When the first model in the chain has quota again (ISO). */
  resetsAt: z.string(),
  /** A batch request stopped by the live app's reserve (models still have a few calls for the app). */
  reserved: z.boolean().optional(),
});
export type QuotaExhaustedBody = z.infer<typeof QuotaExhaustedBodySchema>;

/** One model in GET /v1/ai-usage and `pnpm ai:quota`. */
export const AiModelUsageSchema = z.object({
  model: z.string(),
  /** turn, journal, story, check: the roles whose chain starts on this model (a fallback for the rest). */
  roles: z.array(z.string()),
  /** Calls made today (the free tier's day). */
  calls: z.number().int().nonnegative(),
  /** The daily request limit, from config or learned from a 429 (unknown until then). */
  limit: z.number().int().positive().optional(),
  /** Calls batch scripts may not use (kept for the live app), when the limit is known. */
  reserve: z.number().int().nonnegative().optional(),
  exhausted: z.boolean(),
  /** When the model has quota again (ISO), while exhausted. */
  resetsAt: z.string().optional(),
});
export type AiModelUsage = z.infer<typeof AiModelUsageSchema>;

export const AiUsageSchema = z.object({
  /** The quota day, "YYYY-MM-DD" (Pacific). */
  day: z.string(),
  /** The next daily reset (ISO). */
  nextReset: z.string(),
  models: z.array(AiModelUsageSchema),
  storiesToday: z.number().int().nonnegative(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

/** "03:00" and "3 am" for an instant in `timeZone`, and whole hours from `now` (at least 1). */
export function quotaResetTime(
  resetsAt: Date,
  now: Date,
  timeZone: string,
): { clock: string; spoken: string; hours: number } {
  const p = zonedParts(resetsAt, timeZone);
  const clock = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const spoken = `${h12}${p.minute ? `:${String(p.minute).padStart(2, '0')}` : ''} ${p.hour < 12 ? 'am' : 'pm'}`;
  const hours = Math.max(1, Math.round((resetsAt.getTime() - now.getTime()) / 3_600_000));
  return { clock, spoken, hours };
}

/** Phase 33 Part B: what a script prints when the free quota stops it. Without counts (an eval
 * that does not resume) it only says when to run it again. */
export function scriptQuotaStopMessage(opts: {
  /** "Checked", "Wrote"… (default "Checked"). */
  verb?: string;
  done?: number;
  total?: number;
  /** "lines", "stories"… */
  unit?: string;
  resetsAt: Date;
  now: Date;
  timeZone?: string;
}): string {
  const { clock, hours } = quotaResetTime(opts.resetsAt, opts.now, opts.timeZone ?? 'America/New_York');
  const n = (x: number) => x.toLocaleString('en-US');
  const progress =
    opts.done !== undefined && opts.total !== undefined
      ? ` ${opts.verb ?? 'Checked'} ${n(opts.done)} of ${n(opts.total)} ${opts.unit ?? 'items'}; the rest resumes from here.`
      : '';
  return `Free quota used up.${progress} Quota resets at about ${clock} (in ${hours} h). Run the same command again then.`;
}
