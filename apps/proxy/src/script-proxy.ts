// Phase 33 Part B: scripts that call a running proxy (evals) send `x-ai-priority: batch`, so the live
// app keeps its reserve, and stop at the proxy's 503 quota_exhausted instead of failing on.
import { QuotaExhaustedBodySchema, scriptQuotaStopMessage } from '@anan/core';

/** The proxy said the free quota is used up on every model of the chain. */
export class ProxyQuotaStop extends Error {
  constructor(readonly resetsAt: Date) {
    super(`free quota used up until ${resetsAt.toISOString()}`);
    this.name = 'ProxyQuotaStop';
  }
}

/** POST to the proxy as a batch request. Throws ProxyQuotaStop on quota_exhausted. */
export async function postAsBatch(
  url: string,
  body: unknown,
  opts: { installId: string; siteCode?: string; model?: string; fetchFn?: typeof fetch },
): Promise<Response> {
  const res = await (opts.fetchFn ?? fetch)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-install-id': opts.installId,
      'x-site-code': opts.siteCode ?? process.env.SITE_CODE ?? '',
      'x-ai-priority': 'batch',
      ...(opts.model ? { 'x-ai-model': opts.model } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 503) {
    const parsed = QuotaExhaustedBodySchema.safeParse(await res.clone().json().catch(() => null));
    if (parsed.success) throw new ProxyQuotaStop(new Date(parsed.data.resetsAt));
  }
  return res;
}

/** Top-level handler for an eval: a quota stop prints when to run again and exits 0. */
export function exitOnQuotaStop(err: unknown, done?: { done: number; total: number; unit: string }): never {
  if (err instanceof ProxyQuotaStop) {
    console.log(scriptQuotaStopMessage({ resetsAt: err.resetsAt, now: new Date(), ...(done ?? {}) }));
    process.exit(0);
  }
  throw err;
}
