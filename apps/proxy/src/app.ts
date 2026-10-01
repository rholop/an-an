import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { TurnRequestSchema } from '@anan/core';
import type { Env } from './env.js';
import { buildEffectiveSystemPrompt, type Orchestrator } from './orchestrator.js';
import { buildSystemPrompt } from './prompt.js';
import type { RateLimiter } from './rate-limit.js';
import type { ScenarioStore } from './scenarios.js';

export interface AppDeps {
  env: Pick<Env, 'CORS_ORIGIN'>;
  scenarioStore: ScenarioStore;
  promptTemplate: string;
  orchestrator: Orchestrator;
  rateLimiter: RateLimiter;
  log?: (entry: Record<string, unknown>) => void;
}

/** Factory, not a module-level singleton — tests inject fakes for every
 * dependency (scenario store, orchestrator, rate limiter) and drive the
 * whole app via Hono's app.request(), no real server/network/API keys. */
export function createApp(deps: AppDeps): Hono {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const app = new Hono();

  app.use('*', cors({ origin: deps.env.CORS_ORIGIN }));

  app.get('/v1/health', (c) => c.json({ ok: true }));

  app.post('/v1/turn', async (c) => {
    const installId = c.req.header('x-install-id');
    if (!installId) return c.json({ error: 'missing X-Install-Id header' }, 400);

    const rateCheck = deps.rateLimiter.check(installId);
    if (!rateCheck.allowed) {
      if (rateCheck.reason === 'daily_budget') {
        return c.json({ error: 'daily token budget exhausted, try again tomorrow' }, 429);
      }
      return c.json(
        { error: 'rate limited, please retry shortly', retryAfterMs: rateCheck.retryAfterMs },
        429,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = TurnRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid TurnRequest', details: parsed.error.flatten() }, 400);
    }
    const turnRequest = parsed.data;

    const scenario = deps.scenarioStore.get(turnRequest.scenarioId);
    if (!scenario) {
      return c.json({ error: `unknown scenarioId "${turnRequest.scenarioId}"` }, 404);
    }

    const baseSystemPrompt = buildSystemPrompt(deps.promptTemplate, scenario, turnRequest);
    const effectiveSystemPrompt = buildEffectiveSystemPrompt(baseSystemPrompt, turnRequest.feedback);

    try {
      const { result, log: runLog } = await deps.orchestrator.run(effectiveSystemPrompt, turnRequest.history);
      const totalTokens = runLog.usage.inputTokens + runLog.usage.outputTokens;
      deps.rateLimiter.recordUsage(installId, totalTokens);
      log({ route: '/v1/turn', installId, scenarioId: turnRequest.scenarioId, totalTokens, ...runLog });
      return c.json(result.response);
    } catch (err) {
      log({ route: '/v1/turn', installId, scenarioId: turnRequest.scenarioId, error: String(err) });
      return c.json({ error: 'turn generation failed' }, 502);
    }
  });

  return app;
}
