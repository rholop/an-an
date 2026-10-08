import {
  SentenceGenResponseSchema,
  type SentenceGenRequest,
  type SentenceGenResponse,
} from '@anan/core';

export interface SentenceGenClient {
  generate(req: SentenceGenRequest): Promise<SentenceGenResponse>;
}

/**
 * Calls apps/proxy's POST /v1/sentences (phase doc 04 §1) — the pipeline
 * never talks to Gemini directly or holds an API key itself
 * (CLAUDE.md: "A small backend LLM proxy holds the API keys"). One retry on
 * a 429 (rate limit): a batch job hitting the same proxy budget a live
 * learner uses is exactly the case the proxy's "busy, retrying" framing
 * (phase doc 03 §1) is for.
 */
export function createHttpSentenceGenClient(
  proxyUrl: string,
  installId = 'data-pipeline',
): SentenceGenClient {
  async function post(req: SentenceGenRequest): Promise<Response> {
    return fetch(`${proxyUrl}/v1/sentences`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-install-id': installId,
        'x-site-code': process.env.SITE_CODE ?? '',
      },
      body: JSON.stringify(req),
    });
  }

  return {
    async generate(req) {
      let res = await post(req);
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retryAfterMs?: number };
        await new Promise((resolve) => setTimeout(resolve, body.retryAfterMs ?? 2000));
        res = await post(req);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`POST /v1/sentences failed (${res.status}): ${JSON.stringify(body)}`);
      }
      return SentenceGenResponseSchema.parse(await res.json());
    },
  };
}

/** Templates deliberately built only from CORE_FILLERS (see
 * build-sentences.ts), which the caller guarantees are always part of a
 * word's sampled allowedVocab — so these pass the same analyzeText
 * validation a real generated sentence would, without a live LLM. For
 * exercising the pipeline's generate -> validate -> dedupe -> write
 * machinery in a keyless sandbox only; says nothing about real sentence
 * quality (see apps/proxy/README.md's `--fake` scripted-run caveat for the
 * same idea applied to Phase 3's chat turns). */
export function createFakeSentenceGenClient(): SentenceGenClient {
  const templates: ((headword: string) => string)[] = [
    (hw) => `我${hw}。`,
    (hw) => `${hw}很好。`,
    (hw) => `我去${hw}了。`,
    (hw) => `我很喜歡${hw}。`,
    (hw) => `你的${hw}很好。`,
  ];

  return {
    async generate(req) {
      const sentences = templates.slice(0, req.count).map((template) => ({
        zh: template(req.word.headword),
        en: `(fake) ${req.word.glossEn}`,
        tokens: [{ text: req.word.headword }],
      }));
      return { sentences };
    },
  };
}
