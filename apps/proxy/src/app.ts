import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AudioKindSchema, isProfileId } from '@anan/core';
import { z } from 'zod';
import {
  ClozeCheckRequestSchema,
  ClozeCheckResponseSchema,
  DefineRequestSchema,
  DefineResponseSchema,
  GlossAdjudicationRequestSchema,
  GlossAdjudicationResponseSchema,
  JournalCheckRequestSchema,
  JournalCheckResponseSchema,
  JournalExplainRequestSchema,
  JournalExplainResponseSchema,
  JournalReviewRequestSchema,
  JournalSentenceFixRequestSchema,
  ModelSentenceReviewSchema,
  JournalSolveRequestSchema,
  JournalSolveResponseSchema,
  JournalVerifyRequestSchema,
  JournalVerifyResponseSchema,
  JournalReviewSchema,
  SentenceGenRequestSchema,
  TurnRequestSchema,
} from '@anan/core';
import type { Env } from './env.js';
import { renderFlaggedMarkdown, type AudioStore } from './audio-store.js';
import { requireSiteCode } from './site-code.js';
import type { SyncStore } from './sync-store.js';
import type { TextbookPrivateKind, TextbookStore } from './textbook-store.js';
import {
  CLOZE_CHECK_JSON_SCHEMA,
  DEFINE_JSON_SCHEMA,
  GLOSS_JSON_SCHEMA,
  JOURNAL_CHECK_JSON_SCHEMA,
  JOURNAL_EXPLAIN_JSON_SCHEMA,
  JOURNAL_REVIEW_JSON_SCHEMA,
  JOURNAL_SENTENCE_FIX_JSON_SCHEMA,
  JOURNAL_SOLVE_JSON_SCHEMA,
  JOURNAL_VERIFY_JSON_SCHEMA,
} from './json-schema.js';
import {
  buildEffectiveSystemPrompt,
  type JsonOrchestrator,
  type Orchestrator,
  type SentenceOrchestrator,
} from './orchestrator.js';
import {
  buildClozeCheckPrompt,
  buildSentenceFixPrompt,
  buildSolvePrompt,
  buildVerifyPrompt,
  sentenceFixUserMessage,
  solveUserMessage,
  verifyUserMessage,
  buildJournalCheckPrompt,
  clozeCheckUserMessage,
  buildJournalExplainPrompt,
  buildJournalReviewPrompt,
  defineUserMessage,
  glossAdjudicateUserMessage,
  type GlossPrompts,
  buildSentenceGenPrompt,
  buildSystemPrompt,
  journalCheckUserMessage,
  journalExplainUserMessage,
  journalReviewUserMessage,
  type JournalPrompts,
} from './prompt.js';
import type { RateLimiter } from './rate-limit.js';
import type { ScenarioStore } from './scenarios.js';

export interface AppDeps {
  env: Pick<Env, 'CORS_ORIGIN'>;
  scenarioStore: ScenarioStore;
  promptTemplate: string;
  orchestrator: Orchestrator;
  sentencePromptTemplate: string;
  sentenceOrchestrator: SentenceOrchestrator;
  /** Phase 5 journal endpoints. */
  journal: { prompts: JournalPrompts; orchestrator: JsonOrchestrator };
  /** Phase 7: gloss adjudication + out-of-lexicon definitions (same JSON orchestrator). */
  gloss: { prompts: GlossPrompts; orchestrator: JsonOrchestrator };
  /** The household code (env SITE_CODE). Required on every route but /v1/health. */
  siteCode: string;
  /** Phase 8: per-profile saved copies. */
  sync: SyncStore;
  /** Phase 10: audio OK / "sounds wrong" marks. */
  audio: AudioStore;
  /** Phase 12: private textbook text (dialogues, examples). */
  textbook?: TextbookStore;
  rateLimiter: RateLimiter;
  log?: (entry: Record<string, unknown>) => void;
}

/** Factory, not a module-level singleton — tests inject fakes for every
 * dependency (scenario store, orchestrator, rate limiter) and drive the
 * whole app via Hono's app.request(), no real server/network/API keys. */
export function createApp(deps: AppDeps): Hono {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const app = new Hono();

  app.use('*', cors({ origin: deps.env.CORS_ORIGIN, exposeHeaders: ['x-served-by'] }));

  app.get('/v1/health', (c) => c.json({ ok: true }));

  // Everything else — sync AND every AI route — needs the household code.
  app.use('/v1/*', async (c, next) =>
    c.req.path === '/v1/health' ? next() : requireSiteCode(deps.siteCode)(c, next),
  );

  /** The web app's once-per-browser "is this code right?" check. */
  app.get('/v1/auth/check', (c) => c.json({ ok: true }));

  // ---- Phase 8 sync: GET/PUT one profile's saved copy --------------------
  const SYNC_MAX_BYTES = 40 * 1024 * 1024;

  app.get('/v1/sync/:profileId', async (c) => {
    const profileId = c.req.param('profileId');
    if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
    const rec = await deps.sync.get(profileId);
    if (!rec) return c.json({ rev: 0, updatedAt: null, data: null });
    return c.json({
      rev: rec.rev,
      updatedAt: rec.updatedAt,
      data: JSON.parse(gunzipSync(rec.blob).toString('utf8')),
    });
  });

  app.put(
    '/v1/sync/:profileId',
    bodyLimit({ maxSize: SYNC_MAX_BYTES, onError: (c) => c.json({ error: 'too large' }, 413) }),
    async (c) => {
      const profileId = c.req.param('profileId');
      if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
      let body: { baseRev?: unknown; data?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      if (
        typeof body.baseRev !== 'number' ||
        !Number.isInteger(body.baseRev) ||
        body.baseRev < 0 ||
        typeof body.data !== 'object' ||
        body.data === null
      ) {
        return c.json({ error: 'expected { baseRev: number, data: object }' }, 400);
      }
      const result = await deps.sync.put(
        profileId,
        gzipSync(JSON.stringify(body.data)),
        body.baseRev,
      );
      if (!result.ok) {
        const cur = result.current;
        log({
          route: 'PUT /v1/sync',
          profileId,
          conflict: true,
          baseRev: body.baseRev,
          serverRev: cur?.rev ?? 0,
        });
        // 409 carries the server copy so the client can merge and retry in one round trip.
        return c.json(
          {
            error: 'stale baseRev',
            rev: cur?.rev ?? 0,
            updatedAt: cur?.updatedAt ?? null,
            data: cur ? JSON.parse(gunzipSync(cur.blob).toString('utf8')) : null,
          },
          409,
        );
      }
      log({ route: 'PUT /v1/sync', profileId, rev: result.rev });
      return c.json({ rev: result.rev, updatedAt: result.updatedAt });
    },
  );

  // ---- Phase 10 audio marks: shared by both profiles ----------------------
  const AudioMarkRequestSchema = z.object({
    kind: AudioKindSchema,
    id: z.string().min(1).max(200),
    /** The hash of the clip version the person heard (ties the mark to it). */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(['verified', 'flagged']),
    text: z.string().max(500),
    profileId: z.string(),
  });

  app.get('/v1/audio/marks', async (c) => c.json({ marks: await deps.audio.marks() }));

  app.post('/v1/audio/mark', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = AudioMarkRequestSchema.safeParse(body);
    if (!parsed.success || !isProfileId(parsed.data.profileId)) {
      return c.json({ error: 'invalid audio mark' }, 400);
    }
    const { kind, id, hash, status, text, profileId } = parsed.data;
    const key = `${kind}:${id}`;
    const mark = { status, hash, by: profileId, at: new Date().toISOString(), kind, text };
    await deps.audio.set(key, mark);
    log({ route: 'POST /v1/audio/mark', key, status, by: profileId });
    return c.json({ key, mark });
  });

  app.get('/v1/audio/review.md', async (c) =>
    c.text(renderFlaggedMarkdown(await deps.audio.marks()), 200, {
      'content-type': 'text/markdown; charset=utf-8',
    }),
  );

  // ---- Phase 12 textbook: the book's own text, household code required ----
  // (The /v1/* guard above already enforces the code; there is no public route.)
  app.get('/v1/textbook/:bookId/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'dialogues' && kind !== 'examples') return c.json({ error: 'unknown resource' }, 404);
    const data = await deps.textbook?.get(c.req.param('bookId'), kind as TextbookPrivateKind);
    if (data === undefined) return c.json({ error: 'textbook text not installed' }, 404);
    return c.json(data, 200, { 'cache-control': 'private, max-age=3600' });
  });

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
    const effectiveSystemPrompt = buildEffectiveSystemPrompt(
      baseSystemPrompt,
      turnRequest.feedback,
    );

    try {
      const { result, log: runLog } = await deps.orchestrator.run(
        effectiveSystemPrompt,
        turnRequest.history,
      );
      const totalTokens = runLog.usage.inputTokens + runLog.usage.outputTokens;
      deps.rateLimiter.recordUsage(installId, totalTokens);
      log({
        route: '/v1/turn',
        installId,
        scenarioId: turnRequest.scenarioId,
        totalTokens,
        ...runLog,
      });
      return c.json(result.response);
    } catch (err) {
      log({ route: '/v1/turn', installId, scenarioId: turnRequest.scenarioId, error: String(err) });
      return c.json({ error: 'turn generation failed' }, 502);
    }
  });

  app.post('/v1/sentences', async (c) => {
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

    const parsed = SentenceGenRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid SentenceGenRequest', details: parsed.error.flatten() }, 400);
    }
    const sentenceRequest = parsed.data;

    const prompt = buildSentenceGenPrompt(deps.sentencePromptTemplate, sentenceRequest);

    try {
      const { result, log: runLog } = await deps.sentenceOrchestrator.run(prompt);
      const totalTokens = runLog.usage.inputTokens + runLog.usage.outputTokens;
      deps.rateLimiter.recordUsage(installId, totalTokens);
      log({
        route: '/v1/sentences',
        installId,
        headword: sentenceRequest.word.headword,
        totalTokens,
        ...runLog,
      });
      return c.json(result.response);
    } catch (err) {
      log({
        route: '/v1/sentences',
        installId,
        headword: sentenceRequest.word.headword,
        error: String(err),
      });
      return c.json({ error: 'sentence generation failed' }, 502);
    }
  });

  /** Shared plumbing for the three journal routes: install-id + rate limit,
   * JSON body, zod request validation, one orchestrated provider call. */
  async function journalRoute<Req, Res>(
    c: Context,
    route: string,
    requestSchema: z.ZodType<Req, z.ZodTypeDef, unknown>,
    responseSchema: z.ZodType<Res, z.ZodTypeDef, unknown>,
    jsonSchema: object,
    build: (req: Req) => { systemPrompt: string; userMessage: string },
    orchestrator: JsonOrchestrator = deps.journal.orchestrator,
    avoid?: (req: Req) => 'gemini' | 'openai' | undefined,
  ) {
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
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        { error: `invalid request for ${route}`, details: parsed.error.flatten() },
        400,
      );

    try {
      const { result, log: runLog } = await orchestrator.run(
        {
          task: route,
          jsonSchema,
          parse: (raw) => responseSchema.parse(raw),
          ...build(parsed.data),
        },
        { avoidProvider: avoid?.(parsed.data) },
      );
      const totalTokens = runLog.usage.inputTokens + runLog.usage.outputTokens;
      deps.rateLimiter.recordUsage(installId, totalTokens);
      log({ route, installId, totalTokens, ...runLog });
      c.header('x-total-tokens', String(totalTokens));
      c.header('x-served-by', runLog.provider);
      return c.json(result.response);
    } catch (err) {
      log({ route, installId, error: String(err) });
      return c.json({ error: `${route} failed` }, 502);
    }
  }

  app.post('/v1/journal-review', (c) =>
    journalRoute(
      c,
      '/v1/journal-review',
      JournalReviewRequestSchema,
      JournalReviewSchema,
      JOURNAL_REVIEW_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildJournalReviewPrompt(deps.journal.prompts.review, req),
        userMessage: journalReviewUserMessage(req),
      }),
    ),
  );

  app.post('/v1/journal-check', (c) =>
    journalRoute(
      c,
      '/v1/journal-check',
      JournalCheckRequestSchema,
      JournalCheckResponseSchema,
      JOURNAL_CHECK_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildJournalCheckPrompt(deps.journal.prompts.check),
        userMessage: journalCheckUserMessage(req),
      }),
    ),
  );

  app.post('/v1/journal-explain', (c) =>
    journalRoute(
      c,
      '/v1/journal-explain',
      JournalExplainRequestSchema,
      JournalExplainResponseSchema,
      JOURNAL_EXPLAIN_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildJournalExplainPrompt(deps.journal.prompts.explain, req),
        userMessage: journalExplainUserMessage(req),
      }),
    ),
  );

  // Phase 17: the retry of one corrected sentence, the independent checker
  // (never given the original; prefers the provider that did NOT correct), and
  // the cloze solver test.
  app.post('/v1/journal-sentence-fix', (c) =>
    journalRoute(
      c,
      '/v1/journal-sentence-fix',
      JournalSentenceFixRequestSchema,
      ModelSentenceReviewSchema,
      JOURNAL_SENTENCE_FIX_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildSentenceFixPrompt(deps.journal.prompts.sentenceFix, req),
        userMessage: sentenceFixUserMessage(req),
      }),
    ),
  );

  app.post('/v1/journal-verify', (c) =>
    journalRoute(
      c,
      '/v1/journal-verify',
      JournalVerifyRequestSchema,
      JournalVerifyResponseSchema,
      JOURNAL_VERIFY_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildVerifyPrompt(deps.journal.prompts.verify),
        userMessage: verifyUserMessage(req),
      }),
      undefined,
      (req) => req.avoidProvider,
    ),
  );

  app.post('/v1/journal-solve', (c) =>
    journalRoute(
      c,
      '/v1/journal-solve',
      JournalSolveRequestSchema,
      JournalSolveResponseSchema,
      JOURNAL_SOLVE_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildSolvePrompt(deps.journal.prompts.solve),
        userMessage: solveUserMessage(req),
      }),
    ),
  );

  // Phase 16 Part B: one naturalness check of a full corrected sentence.
  app.post('/v1/cloze-check', (c) =>
    journalRoute(
      c,
      '/v1/cloze-check',
      ClozeCheckRequestSchema,
      ClozeCheckResponseSchema,
      CLOZE_CHECK_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildClozeCheckPrompt(deps.journal.prompts.clozeCheck),
        userMessage: clozeCheckUserMessage(req),
      }),
    ),
  );

  app.post('/v1/gloss', (c) =>
    journalRoute(
      c,
      '/v1/gloss',
      GlossAdjudicationRequestSchema,
      GlossAdjudicationResponseSchema,
      GLOSS_JSON_SCHEMA,
      (req) => ({
        systemPrompt: deps.gloss.prompts.adjudicate,
        userMessage: glossAdjudicateUserMessage(req),
      }),
      deps.gloss.orchestrator,
    ),
  );

  app.post('/v1/define', (c) =>
    journalRoute(
      c,
      '/v1/define',
      DefineRequestSchema,
      DefineResponseSchema,
      DEFINE_JSON_SCHEMA,
      (req) => ({ systemPrompt: deps.gloss.prompts.define, userMessage: defineUserMessage(req) }),
      deps.gloss.orchestrator,
    ),
  );

  return app;
}
