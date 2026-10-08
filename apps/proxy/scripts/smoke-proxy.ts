/**
 * Phase 25: optional LIVE smoke test. The contract tests (src/contract.test.ts) check the request
 * shape offline; this sends one tiny request per JSON route to each configured Gemini model and
 * fails if Gemini REJECTS the request (bad_request / auth), which is what broke /v1/story.
 * A reply that does not match the schema is reported but is not a failure here: that is the
 * route's validation job.
 *
 *   GEMINI_API_KEY=… pnpm smoke:proxy
 *
 * With PROXY_URL set (e.g. https://holop.dev/an-an/api) it also checks GET /v1/health there.
 * With no keys and no PROXY_URL it prints "skipped" and exits 0.
 */
import { JSON_ROUTES } from '../src/json-routes.js';
import { loadEnv } from '../src/env.js';
import { GeminiAdapter } from '../src/providers/gemini.js';
import { ProviderRetryableError } from '../src/providers/types.js';
import { applyZodLimits, trimToLimits } from '../src/zod-limits.js';

const env = loadEnv();
const proxyUrl = process.env.PROXY_URL;
const adapters: Array<{ name: string; adapter: GeminiAdapter }> = [];
if (env.GEMINI_API_KEY)
  for (const model of new Set([env.GEMINI_MODEL_JOURNAL, env.GEMINI_MODEL_TURN, env.GEMINI_MODEL_FALLBACK, env.GEMINI_MODEL_CHECK]))
    adapters.push({ name: model, adapter: new GeminiAdapter(env.GEMINI_API_KEY, model) });

if (adapters.length === 0 && !proxyUrl) {
  console.log('smoke:proxy skipped: no GEMINI_API_KEY and no PROXY_URL.');
  process.exit(0);
}

let failed = 0;
const REJECTED = new Set(['bad_request', 'auth']);

if (proxyUrl) {
  try {
    const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/v1/health`);
    console.log(`health ${res.status} ${await res.text()}`);
    if (!res.ok) failed++;
  } catch (err) {
    console.log(`health unreachable: ${(err as Error).message}`);
    failed++;
  }
}

for (const { name, adapter } of adapters) {
  for (const { route, zod, json } of JSON_ROUTES) {
    const limited = applyZodLimits(json, zod);
    const prompt =
      'This is a connectivity test. Return the smallest JSON object that fits the schema. Use 好 for any Chinese text.';
    try {
      if (route === '/v1/turn') await adapter.generateTurn(prompt, []);
      else if (route === '/v1/sentences') await adapter.generateSentences(prompt);
      else
        await adapter.generateJson({
          task: route,
          systemPrompt: prompt,
          userMessage: '{}',
          jsonSchema: limited,
          parse: (raw: unknown) => zod.parse(trimToLimits(raw, limited)),
        });
      console.log(`ok       ${name} ${route}`);
    } catch (err) {
      const reason = err instanceof ProviderRetryableError ? err.reason : 'error';
      const rejected = REJECTED.has(reason);
      if (rejected) failed++;
      console.log(
        `${rejected ? 'REJECTED' : 'answered'} ${name} ${route} (${reason}${rejected ? `: ${(err as Error).message.slice(0, 200)}` : ''})`,
      );
    }
  }
}

console.log(failed ? `${failed} request(s) rejected.` : 'Gemini rejected no request.');
process.exit(failed ? 1 : 0);
