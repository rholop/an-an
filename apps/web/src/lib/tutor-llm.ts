import { authHeaders, handleUnauthorized, proxyBase } from './api.js';
import {
  ClozeCheckResponseSchema,
  DefineResponseSchema,
  JournalCheckResponseSchema,
  JournalExplainResponseSchema,
  JournalVerifyResponseSchema,
  JournalSolveResponseSchema,
  ModelSentenceReviewSchema,
  ProviderNameSchema,
  JournalReviewSchema,
  SentenceGenResponseSchema,
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
  type ProviderName,
  type SentenceGenRequest,
  type SentenceGenResponse,
  type TurnRequest,
  type TurnResponse,
  type TutorLLM,
} from '@anan/core';

export { getInstallId } from './api.js';

export class ProxyTurnError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ProxyTurnError';
  }
}

/** apps/web's implementation of core's TutorLLM — fetch to apps/proxy. Never
 * holds an API key (CLAUDE.md §"No LLM API keys in the browser, ever"). */
export class FetchTutorLLM implements TutorLLM {
  constructor(private readonly base: string = proxyBase()) {}

  private async post(route: string, body: unknown): Promise<unknown> {
    return (await this.postWithMeta(route, body)).json;
  }

  /** Also returns which provider answered (the proxy's `x-served-by`). A
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
        };
        const wait = errBody.retryAfterMs;
        if (res.status === 429 && wait !== undefined && wait <= 30_000 && attempt < 3) {
          await new Promise((r) => setTimeout(r, wait + 50));
          continue;
        }
        throw new ProxyTurnError(errBody.error ?? `HTTP ${res.status}`, res.status);
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
}
