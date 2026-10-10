import { authHeaders, handleUnauthorized, proxyBase } from './api.js';
import {
  ClozeCheckResponseSchema,
  DefineResponseSchema,
  JournalCheckResponseSchema,
  JournalExplainResponseSchema,
  JournalExplainCheckResponseSchema,
  IssueExplanationSchema,
  JournalAskResponseSchema,
  JournalGapResponseSchema,
  type JournalExplainCheckRequest,
  type JournalExplainCheckResponse,
  type JournalWhyRequest,
  type IssueExplanation,
  type JournalAskRequest,
  type JournalAskResponse,
  type JournalGapRequest,
  type JournalGapResponse,
  JournalVerifyResponseSchema,
  JournalSolveResponseSchema,
  ModelSentenceReviewSchema,
  ProviderNameSchema,
  JournalReviewSchema,
  SentenceGenResponseSchema,
  StoryCheckResponseSchema,
  StoryRepairResponseSchema,
  type StoryRepairRequest,
  type StoryRepairResponse,
  StoryResponseSchema,
  TopicWordsResponseSchema,
  TurnResponseSchema,
  type DefineRequest,
  type DefineResponse,
  type JournalCheckRequest,
  type JournalCheckResponse,
  type JournalExplainRequest,
  type JournalExplainResponse,
  type JournalReview,
  type JournalReviewRequest,
  type JournalSentenceFixRequest,
  type JournalSolveRequest,
  type JournalSolveResponse,
  type JournalVerifyRequest,
  type JournalVerifyResponse,
  type ModelSentenceReview,
  type OpenTurnRequest,
  type ProviderName,
  type SentenceGenRequest,
  type SentenceGenResponse,
  type StoryCheckRequest,
  type StoryCheckResponse,
  type StoryLLM,
  type StoryRequest,
  type StoryResponse,
  type TopicWordsRequest,
  type TopicWordsResponse,
  type TurnRequest,
  type TurnResponse,
  type TutorLLM,
} from '@anan/core';

export { getInstallId } from './api.js';
import { noteQuotaExhausted, quotaResetFrom, quotaText } from './ai-quota.js';

export class ProxyTurnError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Phase 25: the free Gemini quota (or the proxy's own budget) is used up for now. */
    public readonly quota = false,
    /** Phase 33: every free model is out until then (the proxy's 503 quota_exhausted). */
    public readonly resetsAt?: Date,
  ) {
    super(message);
    this.name = 'ProxyTurnError';
  }
}

const QUOTA_REASONS = new Set(['rate_limited', 'quota', 'exhausted', 'reserved']);

/** Phase 25: is this failure the free AI quota running out (show "Try again in a few minutes")? */
export function isQuotaError(err: unknown): boolean {
  return err instanceof ProxyTurnError && err.quota;
}

/** Phase 33: the plain words for a quota failure ("…used up until about 3 am. Lessons, review and
 * everything else still work."), or undefined for any other error. */
export function aiQuotaErrorText(err: unknown, now: Date = new Date()): string | undefined {
  return isQuotaError(err) ? quotaText((err as ProxyTurnError).resetsAt, now) : undefined;
}

/** What a failed AI call shows: the quota text, else the error's message. */
export function aiErrorText(err: unknown): string {
  return aiQuotaErrorText(err) ?? (err instanceof Error ? err.message : String(err));
}

/** apps/web's implementation of core's TutorLLM — fetch to apps/proxy. Never
 * holds an API key (CLAUDE.md §"No LLM API keys in the browser, ever"). */
export class FetchTutorLLM implements TutorLLM, StoryLLM {
  constructor(private readonly base: string = proxyBase()) {}

  private async post(route: string, body: unknown): Promise<unknown> {
    return (await this.postWithMeta(route, body)).json;
  }

  /** Also returns which Gemini model answered (the proxy's `x-served-by`). A
   * short rate-limit wait is retried: the journal pipeline makes several calls. */
  private async postWithMeta(
    route: string,
    body: unknown,
  ): Promise<{ json: unknown; servedBy?: ProviderName }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status === 401) handleUnauthorized();

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          retryAfterMs?: number;
          attempts?: Array<{ model?: string; reason?: string }>;
        };
        const wait = errBody.retryAfterMs;
        if (res.status === 429 && wait !== undefined && wait <= 30_000 && attempt < 3) {
          await new Promise((r) => setTimeout(r, wait + 50));
          continue;
        }
        // Phase 33: every free model is out until `resetsAt`: background stories wait until then
        const resetsAt = quotaResetFrom(res.status, errBody);
        if (resetsAt) {
          noteQuotaExhausted(resetsAt);
          throw new ProxyTurnError('quota_exhausted', res.status, true, resetsAt);
        }
        const quota =
          res.status === 429 ||
          (Array.isArray(errBody.attempts) &&
            errBody.attempts.length > 0 &&
            errBody.attempts.every((a) => QUOTA_REASONS.has(a.reason ?? '')));
        throw new ProxyTurnError(errBody.error ?? `HTTP ${res.status}`, res.status, quota);
      }
      const served = ProviderNameSchema.safeParse(res.headers.get('x-served-by'));
      return { json: await res.json(), servedBy: served.success ? served.data : undefined };
    }
  }

  // Every response is validated again client-side even though the proxy
  // already validated it server-side — never trust a network response shape
  // blindly (CLAUDE.md: "LLM output is data to validate, never trusted").
  // Journal results additionally go through validateJournalReview() in
  // JournalService before anything is shown or stored.

  async generateTurn(req: TurnRequest): Promise<TurnResponse> {
    return TurnResponseSchema.parse(await this.post('/v1/turn', req));
  }

  /** Phase 18: the same route, `mode: 'open'`. */
  async generateOpenTurn(req: OpenTurnRequest): Promise<TurnResponse> {
    return TurnResponseSchema.parse(await this.post('/v1/turn', req));
  }

  async generateTopicWords(req: TopicWordsRequest): Promise<TopicWordsResponse> {
    return TopicWordsResponseSchema.parse(await this.post('/v1/topic-words', req));
  }

  async reviewJournal(req: JournalReviewRequest): Promise<JournalReview> {
    const { json, servedBy } = await this.postWithMeta('/v1/journal-review', req);
    return { ...JournalReviewSchema.parse(json), servedBy };
  }

  async fixJournalSentence(
    req: JournalSentenceFixRequest,
  ): Promise<{ review: ModelSentenceReview; servedBy?: ProviderName }> {
    const { json, servedBy } = await this.postWithMeta('/v1/journal-sentence-fix', req);
    return { review: ModelSentenceReviewSchema.parse(json), servedBy };
  }

  async verifyJournalSentence(req: JournalVerifyRequest): Promise<JournalVerifyResponse> {
    return JournalVerifyResponseSchema.parse(await this.post('/v1/journal-verify', req));
  }

  async solveJournalCloze(req: JournalSolveRequest): Promise<JournalSolveResponse> {
    return JournalSolveResponseSchema.parse(await this.post('/v1/journal-solve', req));
  }

  async checkJournalFix(req: JournalCheckRequest): Promise<JournalCheckResponse> {
    return JournalCheckResponseSchema.parse(await this.post('/v1/journal-check', req));
  }

  async checkCloze(req: { sentence: string }): Promise<{ ok: boolean; reason?: string }> {
    return ClozeCheckResponseSchema.parse(await this.post('/v1/cloze-check', req));
  }

  async defineWord(req: DefineRequest): Promise<DefineResponse> {
    return DefineResponseSchema.parse(await this.post('/v1/define', req));
  }

  async generateSentences(req: SentenceGenRequest): Promise<SentenceGenResponse> {
    return SentenceGenResponseSchema.parse(await this.post('/v1/sentences', req));
  }

  async explainJournalIssue(req: JournalExplainRequest): Promise<JournalExplainResponse> {
    return JournalExplainResponseSchema.parse(await this.post('/v1/journal-explain', req));
  }

  /** Phase 31: the independent check of every "Why?" (the proxy's checker model). */
  async checkJournalExplanations(req: JournalExplainCheckRequest): Promise<JournalExplainCheckResponse> {
    return JournalExplainCheckResponseSchema.parse(await this.post('/v1/journal-explain-check', req));
  }

  /** Phase 31: a fresh "Why?" after the check objected. */
  async explainJournalWhy(req: JournalWhyRequest): Promise<IssueExplanation> {
    return IssueExplanationSchema.parse(await this.post('/v1/journal-why', req));
  }

  /** Phase 31: "Ask about this" (counts toward the daily token budget like every AI route). */
  async askJournal(req: JournalAskRequest): Promise<JournalAskResponse> {
    return JournalAskResponseSchema.parse(await this.post('/v1/journal-ask', req));
  }

  /** Phase 31: an `[english]` gap translated in its sentence. */
  async fillJournalGap(req: JournalGapRequest): Promise<JournalGapResponse> {
    return JournalGapResponseSchema.parse(await this.post('/v1/journal-gap', req));
  }

  /** Phase 24: a graded story (Phase 25: Gemini only, a fallback Gemini model) and which model wrote it. */
  async writeStory(req: StoryRequest): Promise<{ story: StoryResponse; servedBy?: ProviderName }> {
    const { json, servedBy } = await this.postWithMeta('/v1/story', req);
    return { story: StoryResponseSchema.parse(json), servedBy };
  }

  /** Phase 24: the independent read (Phase 25: a fresh call on the proxy's checker model). */
  async checkStory(req: StoryCheckRequest): Promise<StoryCheckResponse> {
    return StoryCheckResponseSchema.parse(await this.post('/v1/story-check', req));
  }

  /** Phase 26: rewrite only the sentences with a problem word (never cached by the proxy). */
  async repairStory(req: StoryRepairRequest): Promise<StoryRepairResponse> {
    return StoryRepairResponseSchema.parse(await this.post('/v1/story-repair', req));
  }
}
