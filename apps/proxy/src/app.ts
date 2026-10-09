import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AudioKindSchema, isProfileId, summarizeSavedCopy, type SavedCopySummary } from '@anan/core';
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
  OpenTurnRequestSchema,
  SentenceGenRequestSchema,
  StoryCheckRequestSchema,
  StoryCheckResponseSchema,
  StoryRequestSchema,
  StoryRepairRequestSchema,
  StoryRepairResponseSchema,
  StoryResponseSchema,
  TopicWordsRequestSchema,
  TopicWordsResponseSchema,
  TurnRequestSchema,
  type OpenChatPersona,
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
  STORY_CHECK_JSON_SCHEMA,
  STORY_REPAIR_JSON_SCHEMA,
  STORY_JSON_SCHEMA,
  TOPIC_WORDS_JSON_SCHEMA,
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
  buildOpenSystemPrompt,
  buildStoryPrompt,
  storyCheckUserMessage,
  storyUserMessage,
  storyRepairUserMessage,
  buildSystemPrompt,
  topicWordsUserMessage,
  journalCheckUserMessage,
  journalExplainUserMessage,
  journalReviewUserMessage,
  type JournalPrompts,
} from './prompt.js';
import type { RateLimiter } from './rate-limit.js';
import { ModelsFailedError } from './providers/types.js';
import { applyZodLimits, trimToLimits } from './zod-limits.js';

/** Phase 25: '/v1/story-check' → {"error":"story_check_failed","attempts":[{"model":"gemini-…","reason":"rate_limited"}, …]}.
 * Names which model failed and why; never a key or a prompt. Sent with MODEL_FAILURE_STATUS (503):
 * Cloudflare replaces an origin's 502 with its own HTML page, which hid this body in production. */
export const MODEL_FAILURE_STATUS = 503;
export function failureBody(
  route: string,
  err: unknown,
): { error: string; attempts?: ModelsFailedError['attempts'] } {
  const error = `${route.replace(/^\/v1\//, '').replace(/[^a-z0-9]+/gi, '_')}_failed`;
  return err instanceof ModelsFailedError ? { error, attempts: err.attempts } : { error };
}
import type { ScenarioStore } from './scenarios.js';

/** Phase 28: a push may lose at most this share of the saved copy's cards or evidence. */
export const SHRINK_GUARD_SHARE = 0.2;
/** Copies smaller than this are never guarded (a first few answers move a lot in relative terms). */
const SHRINK_GUARD_MIN = 20;

const countsOf = (data: unknown) => {
  const d = data as { items?: unknown; evidence?: unknown };
  return {
    cards: Array.isArray(d.items) ? (d.items as { state?: string }[]).filter((c) => c?.state !== 'unseen').length : 0,
    evidence: Array.isArray(d.evidence) ? d.evidence.length : 0,
  };
};

/** Why a push would shrink the saved copy too much, or null when it is fine. */
export function shrinkReason(
  current: { cards: number; evidence: number },
  next: { cards: number; evidence: number },
  share = SHRINK_GUARD_SHARE,
): string | null {
  for (const k of ['cards', 'evidence'] as const) {
    if (current[k] >= SHRINK_GUARD_MIN && next[k] < current[k] * (1 - share))
      return `${k} would drop from ${current[k]} to ${next[k]}`;
  }
  return null;
}

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
  /** Phase 18: open chat (the persona 安安, its prompt, and the cached topic-word list). */
  openChat?: {
    persona: OpenChatPersona;
    promptTemplate: string;
    topicWordsPrompt: string;
    topicWordsOrchestrator: JsonOrchestrator;
  };
  /** Phase 24: graded stories (writer + independent checker prompts). */
  story?: { prompts: { write: string; check: string; repair: string }; orchestrator?: JsonOrchestrator };
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
  // Phase 28: bodies may be gzipped (content-encoding: gzip; the cap applies to both the compressed
  // body and what it unpacks to), pulls are gzipped when the browser accepts it, a push that would
  // shrink the copy a lot is refused unless confirmed, and saved versions can be listed and read.
  const SYNC_MAX_BYTES = 40 * 1024 * 1024;
  const tooLarge = (c: Context) => c.json({ error: 'too large', limitBytes: SYNC_MAX_BYTES }, 413);

  /** A JSON response, gzipped when the client accepts it (a profile copy is several MB of JSON). */
  const jsonMaybeGzip = (c: Context, text: string, status: 200 | 409 = 200) => {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=UTF-8', vary: 'accept-encoding' };
    if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
      return new Response(gzipSync(text), { status, headers: { ...headers, 'content-encoding': 'gzip' } });
    }
    return new Response(text, { status, headers });
  };
  /** `{"rev":…,"updatedAt":…,"data":…}` without parsing the stored copy again. */
  const copyText = (rec: { rev: number; updatedAt: string; blob: Buffer } | null | undefined, extra: Record<string, unknown> = {}) => {
    const head = JSON.stringify({ ...extra, rev: rec?.rev ?? 0, updatedAt: rec?.updatedAt ?? null });
    return `${head.slice(0, -1)},"data":${rec ? gunzipSync(rec.blob).toString('utf8') : 'null'}}`;
  };

  /** Summaries of stored versions never change (a revision is immutable), so they are kept. */
  const summaries = new Map<string, SavedCopySummary & { bytes: number }>();
  const summaryOf = (profileId: string, rec: { rev: number; blob: Buffer }) => {
    const key = `${profileId}:${rec.rev}`;
    let s = summaries.get(key);
    if (!s) {
      const text = gunzipSync(rec.blob).toString('utf8');
      s = { ...summarizeSavedCopy(JSON.parse(text)), bytes: Buffer.byteLength(text) };
      summaries.set(key, s);
    }
    return s;
  };

  app.get('/v1/sync/:profileId', async (c) => {
    const profileId = c.req.param('profileId');
    if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
    const rec = await deps.sync.get(profileId);
    return jsonMaybeGzip(c, copyText(rec));
  });

  /** Phase 28: the saved versions, newest first, each with what it holds. */
  app.get('/v1/sync/:profileId/versions', async (c) => {
    const profileId = c.req.param('profileId');
    if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
    const versions = await deps.sync.versions(profileId);
    const out = [];
    for (const v of [...versions].reverse()) {
      const rec = await deps.sync.getVersion(profileId, v.rev);
      if (rec) out.push({ rev: v.rev, updatedAt: v.updatedAt, ...summaryOf(profileId, rec) });
    }
    return c.json({ versions: out });
  });

  app.get('/v1/sync/:profileId/versions/:rev', async (c) => {
    const profileId = c.req.param('profileId');
    if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
    const rev = Number(c.req.param('rev'));
    const rec = Number.isInteger(rev) ? await deps.sync.getVersion(profileId, rev) : null;
    if (!rec) return c.json({ error: 'no such version' }, 404);
    return jsonMaybeGzip(c, copyText(rec));
  });

  /** The request body as text: gunzipped when sent with content-encoding: gzip (capped). */
  async function bodyText(c: Context): Promise<string | Response> {
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!/\bgzip\b/i.test(c.req.header('content-encoding') ?? '')) return raw.toString('utf8');
    try {
      return gunzipSync(raw, { maxOutputLength: SYNC_MAX_BYTES }).toString('utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) return tooLarge(c);
      return c.json({ error: 'invalid gzip body' }, 400);
    }
  }

  app.put(
    '/v1/sync/:profileId',
    bodyLimit({ maxSize: SYNC_MAX_BYTES, onError: tooLarge }),
    async (c) => {
      const profileId = c.req.param('profileId');
      if (!isProfileId(profileId)) return c.json({ error: 'unknown profile' }, 404);
      const text = await bodyText(c);
      if (text instanceof Response) return text;
      let body: { baseRev?: unknown; data?: unknown; confirmReplace?: unknown };
      try {
        body = JSON.parse(text);
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
      // Phase 28: a copy that lost a lot of cards or evidence is a bug, not progress: refuse it (409,
      // with the server copy, so the client merges and pushes the union) unless it is a confirmed Replace.
      if (body.confirmReplace !== true) {
        const current = await deps.sync.get(profileId);
        if (current && current.rev === body.baseRev) {
          const reason = shrinkReason(summaryOf(profileId, current), countsOf(body.data));
          if (reason) {
            log({ route: 'PUT /v1/sync', profileId, refused: 'shrink', reason });
            return jsonMaybeGzip(c, copyText(current, { error: 'shrinking copy', reason }), 409);
          }
        }
      }
      const result = await deps.sync.put(profileId, gzipSync(JSON.stringify(body.data)), body.baseRev);
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
        return jsonMaybeGzip(c, copyText(cur, { error: 'stale baseRev' }), 409);
      }
      log({ route: 'PUT /v1/sync', profileId, rev: result.rev, bytes: text.length, gzip: /gzip/i.test(c.req.header('content-encoding') ?? '') });
      return c.json({ rev: result.rev, updatedAt: result.updatedAt });
    },
  );

  // Phase 28: the deploy's body-size check. Accepts a large body and throws it away, so a wrong
  // nginx limit (413 before the request reaches us) can't go unnoticed. Behind the code, rate limited.
  const selftestTimes: number[] = [];
  app.put('/v1/sync-selftest', bodyLimit({ maxSize: SYNC_MAX_BYTES, onError: tooLarge }), async (c) => {
    const now = Date.now();
    while (selftestTimes.length && selftestTimes[0]! < now - 60_000) selftestTimes.shift();
    if (selftestTimes.length >= 6) return c.json({ error: 'rate limited' }, 429);
    selftestTimes.push(now);
    const bytes = (await c.req.arrayBuffer()).byteLength;
    return c.json({ ok: true, bytes });
  });

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
    if (kind !== 'dialogues' && kind !== 'examples' && kind !== 'stories')
      return c.json({ error: 'unknown resource' }, 404);
    const data = await deps.textbook?.get(c.req.param('bookId'), kind as TextbookPrivateKind);
    if (data === undefined) return c.json({ error: 'textbook text not installed' }, 404);
    // Phase 30 Part B.2: revalidated every time (a 304 is cheap), so lesson stories written while
    // the app is open show up on the next Stories open.
    const body = JSON.stringify(data);
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    const headers = { 'cache-control': 'private, no-cache', etag };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    return c.body(body, 200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
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

    // Phase 18: `mode: 'open'` carries { topic, tiers, summary? } instead of scenario fields.
    if (typeof body === 'object' && body !== null && (body as { mode?: unknown }).mode === 'open') {
      const openParsed = OpenTurnRequestSchema.safeParse(body);
      if (!openParsed.success) {
        return c.json(
          { error: 'invalid open TurnRequest', details: openParsed.error.flatten() },
          400,
        );
      }
      if (!deps.openChat) return c.json({ error: 'open chat is not configured' }, 501);
      const openRequest = openParsed.data;
      const openPrompt = buildEffectiveSystemPrompt(
        buildOpenSystemPrompt(deps.openChat.promptTemplate, deps.openChat.persona, openRequest),
        openRequest.feedback,
      );
      try {
        const { result, log: runLog } = await deps.orchestrator.run(
          openPrompt,
          openRequest.history,
          {
            alternate: openRequest.alternateModel === true,
          },
        );
        const totalTokens = runLog.usage.inputTokens + runLog.usage.outputTokens;
        deps.rateLimiter.recordUsage(installId, totalTokens);
        log({ route: '/v1/turn', mode: 'open', installId, totalTokens, ...runLog });
        c.header('x-served-by', runLog.model);
        return c.json(result.response);
      } catch (err) {
        log({ route: '/v1/turn', mode: 'open', installId, error: String(err) });
        return c.json({ ...failureBody('/v1/turn', err), message: 'turn generation failed' }, MODEL_FAILURE_STATUS);
      }
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
        { alternate: turnRequest.alternateModel === true },
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
      return c.json({ ...failureBody('/v1/turn', err), message: 'turn generation failed' }, MODEL_FAILURE_STATUS);
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
      return c.json(
        { ...failureBody('/v1/sentences', err), message: 'sentence generation failed' },
        MODEL_FAILURE_STATUS,
      );
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
    /** Phase 25: the independent check runs on the checker model. */
    checker = false,
    /** Phase 26: requests that must not be answered from the cache (regenerations, repairs). */
    noCache: (req: Req) => boolean = () => false,
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

    const limited = applyZodLimits(jsonSchema, responseSchema);
    try {
      const { result, log: runLog } = await orchestrator.run(
        {
          task: route,
          // Phase 25: the schema the model sees carries the zod limits; small overruns are trimmed
          jsonSchema: limited,
          parse: (raw) => responseSchema.parse(trimToLimits(raw, limited)),
          ...build(parsed.data),
        },
        { checker, noCache: noCache(parsed.data) },
      );
      const totalTokens = runLog.usage.inputTokens + runLog.usage.outputTokens;
      deps.rateLimiter.recordUsage(installId, totalTokens);
      log({ route, installId, totalTokens, ...runLog });
      c.header('x-total-tokens', String(totalTokens));
      c.header('x-served-by', runLog.model);
      return c.json(result.response);
    } catch (err) {
      log({ route, installId, error: String(err) });
      return c.json(failureBody(route, err), MODEL_FAILURE_STATUS);
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
  // (never given the original; a fresh call on the checker model), and
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
      true,
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

  // Phase 18: ~60 words a Taiwanese speaker would use about a topic. Cached by topic + level
  // (the orchestrator keys on the normalised user message), behind the household code like
  // every AI route.
  app.post('/v1/topic-words', (c) => {
    const oc = deps.openChat;
    if (!oc) return c.json({ error: 'open chat is not configured' }, 501);
    return journalRoute(
      c,
      '/v1/topic-words',
      TopicWordsRequestSchema,
      TopicWordsResponseSchema,
      TOPIC_WORDS_JSON_SCHEMA,
      (req) => ({ systemPrompt: oc.topicWordsPrompt, userMessage: topicWordsUserMessage(req) }),
      oc.topicWordsOrchestrator,
    );
  });

  // Phase 24: a graded story, then the independent reader (the checker model, never shown the
  // prompt or the word lists). Both behind the household code, cached like every JSON task.
  app.post('/v1/story', (c) => {
    const st = deps.story;
    if (!st) return c.json({ error: 'stories are not configured' }, 501);
    return journalRoute(
      c,
      '/v1/story',
      StoryRequestSchema,
      StoryResponseSchema,
      STORY_JSON_SCHEMA,
      (req) => ({
        systemPrompt: buildStoryPrompt(st.prompts.write, req),
        userMessage: storyUserMessage(req),
      }),
      st.orchestrator,
      false,
      (req) => req.fresh === true,
    );
  });

  // Phase 26 Part B: only the sentences with a problem word go back to the writer. Never cached:
  // a repair is always a fresh call.
  app.post('/v1/story-repair', (c) => {
    const st = deps.story;
    if (!st) return c.json({ error: 'stories are not configured' }, 501);
    return journalRoute(
      c,
      '/v1/story-repair',
      StoryRepairRequestSchema,
      StoryRepairResponseSchema,
      STORY_REPAIR_JSON_SCHEMA,
      (req) => ({ systemPrompt: st.prompts.repair, userMessage: storyRepairUserMessage(req) }),
      st.orchestrator,
      false,
      () => true,
    );
  });

  app.post('/v1/story-check', (c) => {
    const st = deps.story;
    if (!st) return c.json({ error: 'stories are not configured' }, 501);
    return journalRoute(
      c,
      '/v1/story-check',
      StoryCheckRequestSchema,
      StoryCheckResponseSchema,
      STORY_CHECK_JSON_SCHEMA,
      (req) => ({ systemPrompt: st.prompts.check, userMessage: storyCheckUserMessage(req) }),
      st.orchestrator,
      true,
    );
  });

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
