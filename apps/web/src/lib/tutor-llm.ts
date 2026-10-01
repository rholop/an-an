import { TurnResponseSchema, type TurnRequest, type TurnResponse, type TutorLLM } from '@anan/core';

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

  async generateTurn(req: TurnRequest): Promise<TurnResponse> {
    const res = await fetch(`${this.proxyBase}/v1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': getInstallId() },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ProxyTurnError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
    }

    // Validated again client-side even though the proxy already validated
    // it server-side — never trust a network response shape blindly
    // (CLAUDE.md: "LLM output is data to validate, never trusted").
    return TurnResponseSchema.parse(await res.json());
  }
}
