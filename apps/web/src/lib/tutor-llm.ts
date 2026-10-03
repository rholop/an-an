import { authHeaders, handleUnauthorized, proxyBase } from './api.js';
import {
  DefineResponseSchema,
  JournalCheckResponseSchema,
  JournalExplainResponseSchema,
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
    const res = await fetch(`${this.base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (res.status === 401) handleUnauthorized();

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new ProxyTurnError(
        (errBody as { error?: string }).error ?? `HTTP ${res.status}`,
        res.status,
      );
    }
    return res.json();
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
    return JournalReviewSchema.parse(await this.post('/v1/journal-review', req));
  }

  async checkJournalFix(req: JournalCheckRequest): Promise<JournalCheckResponse> {
    return JournalCheckResponseSchema.parse(await this.post('/v1/journal-check', req));
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
