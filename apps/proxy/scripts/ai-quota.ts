/**
 * Phase 33 Part D: the free Gemini quota on this server (read-only, no model calls).
 *
 *   pnpm ai:quota
 *
 * Each model in the chains with its calls today (the free tier's day, which resets at midnight
 * Pacific), its daily limit (from GEMINI_DAILY_LIMITS or learned from a 429), the reserve batch
 * scripts leave for the live app, and whether it is out of quota and until when (New York time).
 */
import { quotaResetTime } from '@anan/core';
import { resolveChains } from '../src/env.js';
import { loadProxyEnv, sharedQuota } from '../src/script-gemini.js';

const env = loadProxyEnv();
const zone = 'America/New_York';
const usage = sharedQuota(env).usage(resolveChains(env));
const now = new Date();
const at = (iso: string) => {
  const t = quotaResetTime(new Date(iso), now, zone);
  return `${t.clock} (in ${t.hours} h)`;
};
const rows = usage.models.map((m) => [
  m.model,
  m.roles.join(', ') || '-',
  m.limit !== undefined ? `${m.calls} / ${m.limit}` : `${m.calls} / ?`,
  m.reserve !== undefined ? String(m.reserve) : '-',
  m.exhausted ? `out until ${at(m.resetsAt!)}` : 'ok',
]);
const head = ['model', 'first for', 'calls today', 'kept for app', 'quota'];
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ');
console.log(`Free Gemini quota, day ${usage.day} (resets at midnight Pacific = ${at(usage.nextReset)} New York time)`);
console.log(line(head));
console.log(line(widths.map((w) => '-'.repeat(w))));
for (const r of rows) console.log(line(r));
console.log(`Stories written today: ${usage.storiesToday}`);
console.log('Limits per model: https://ai.dev/rate-limit (set known ones in GEMINI_DAILY_LIMITS).');
