import {
  JournalCheckResponseSchema,
  JournalExplainResponseSchema,
  JournalReviewSchema,
  TurnResponseSchema,
  type JournalCheckRequest,
  type JournalCheckResponse,
  type JournalExplainRequest,
  type JournalExplainResponse,
  type JournalReview,
  type JournalReviewRequest,
  type TurnRequest,
  type TurnResponse,
  type TutorLLM,
} from '@anan/core';

function defaultProxyBase(): string {
  const override = import.meta.env.VITE_PROXY_URL;
  if (override) return override;
  // Dev: the proxy runs separately on :3002 (see apps/proxy). Prod: same
  // origin, nginx-routed at <base>/api (see docs/related-repos.md).
  return import.meta.env.DEV ? 'http://localhost:3002' : `${import.meta.env.BASE_URL}api`;
}

const INSTALL_ID_KEY = 'anan-install-id';

/** No user accounts (CLAUDE.md) — a random id persisted in localStorage is
 * enough for the proxy's per-client rate limiting. */
export function getInstallId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

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
  constructor(private readonly proxyBase: string = defaultProxyBase()) {}

  private async post(route: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.proxyBase}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': getInstallId() },
      body: JSON.stringify(body),
    });

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

  async explainJournalIssue(req: JournalExplainRequest): Promise<JournalExplainResponse> {
    return JournalExplainResponseSchema.parse(await this.post('/v1/journal-explain', req));
  }
}
