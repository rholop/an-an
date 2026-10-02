import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkTaiwanness,
  GlossAdjudicationResponseSchema,
  type GlossAdjudicationRequest,
  type GlossAdjudicationResponse,
  type Sense,
} from '@anan/core';
import { contentTokens, glossOverlap } from './normalize.js';

export const MAX_GLOSS_WORDS = 6;

export interface ValidatedAdjudication {
  senses: Omit<Sense, 'id'>[];
  primaryIndex: number;
  confidence: GlossAdjudicationResponse['confidence'];
  flags: string[];
}

export type AdjudicationVerdict =
  { ok: true; value: ValidatedAdjudication } | { ok: false; reasons: string[] };

/** Fraction of `gloss`'s content words found in the cited candidates' text. */
function support(gloss: string, citedTexts: string[]): number {
  const tokens = contentTokens(gloss);
  if (tokens.length === 0) return 0;
  const pool = new Set(citedTexts.flatMap((t) => contentTokens(t)));
  return tokens.filter((t) => pool.has(t)).length / tokens.length;
}

/**
 * LLM output is data to validate (CLAUDE.md). The model may only choose and
 * condense: every sense must cite real candidate ids, be ≤ 6 words, be clean
 * Taiwan-traditional text, and be SUPPORTED by what it cites — either by
 * overlap with a cited English gloss or by being made of its words.
 */
export function validateAdjudication(
  raw: unknown,
  req: GlossAdjudicationRequest,
): AdjudicationVerdict {
  const parsed = GlossAdjudicationResponseSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reasons: [`wrong shape: ${parsed.error.message.slice(0, 120)}`] };
  const res = parsed.data;
  const byId = new Map(req.candidates.map((c) => [c.id, c]));
  const reasons: string[] = [];

  if (!res.senses.some((s) => s.id === res.primarySenseId))
    reasons.push('primarySenseId is not one of the senses');

  const senses: Omit<Sense, 'id'>[] = [];
  const seen = new Set<string>();
  const sources = new Map<string, string[]>();
  for (const s of res.senses) {
    const gloss = s.glossEn.trim();
    const cited = s.basedOn.map((id) => byId.get(id));
    if (cited.some((c) => !c)) {
      reasons.push(`"${gloss}" cites an unknown candidate id`);
      continue;
    }
    if (gloss.split(/\s+/).length > MAX_GLOSS_WORDS) {
      reasons.push(`"${gloss}" is longer than ${MAX_GLOSS_WORDS} words`);
      continue;
    }
    if (!checkTaiwanness(gloss + (s.noteEn ?? '')).isClean) {
      reasons.push(`"${gloss}" contains simplified/mainland text`);
      continue;
    }
    const english = cited.map((c) => c!.glossEn).filter((g): g is string => Boolean(g));
    const supported =
      english.some((g) => glossOverlap(gloss, g) >= 0.5) || support(gloss, english) >= 0.6;
    if (!supported) {
      reasons.push(`"${gloss}" is not supported by its cited sources`);
      continue;
    }
    const key = gloss.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const basedOn = [...new Set(cited.map((c) => c!.source as string))];
    sources.set(s.id, basedOn);
    senses.push({
      glossEn: gloss,
      noteEn: s.noteEn,
      register: s.register,
      taiwanOnly: s.taiwanOnly,
      basedOn,
    });
  }

  const primaryAccepted = res.senses.find((s) => s.id === res.primarySenseId);
  const primaryIndex = primaryAccepted
    ? senses.findIndex(
        (s) => s.glossEn.trim().toLowerCase() === primaryAccepted.glossEn.trim().toLowerCase(),
      )
    : -1;
  if (primaryIndex === -1) reasons.push('the primary sense did not pass validation');
  if (senses.length === 0 || primaryIndex === -1) return { ok: false, reasons };

  const flags: string[] = [];
  if (res.confidence === 'low') flags.push('low-confidence');
  if (reasons.length > 0) flags.push('partly-rejected');
  return { ok: true, value: { senses, primaryIndex, confidence: res.confidence, flags } };
}

// ---------------------------------------------------------------- resumable run

export interface AdjudicationRecord {
  wordId: string;
  hash: string;
  response?: unknown;
  tokens?: number;
  error?: string;
}

export const requestHash = (req: GlossAdjudicationRequest): string =>
  createHash('sha256').update(JSON.stringify(req)).digest('hex').slice(0, 16);

/** Append-only JSONL: a crash or rate-limit stop loses nothing, and a re-run
 * skips every word whose request hash already has a stored response. */
export class AdjudicationStore {
  private readonly done = new Map<string, AdjudicationRecord>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as AdjudicationRecord;
          if (rec.response !== undefined) this.done.set(rec.wordId, rec); // later lines win
        } catch {
          /* torn last line from a killed run: ignore */
        }
      }
    }
  }

  get(wordId: string, hash: string): AdjudicationRecord | undefined {
    const rec = this.done.get(wordId);
    return rec && rec.hash === hash ? rec : undefined;
  }

  all(): AdjudicationRecord[] {
    return [...this.done.values()];
  }

  append(rec: AdjudicationRecord): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
    if (rec.response !== undefined) this.done.set(rec.wordId, rec);
  }
}

export class ProxyHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export type AdjudicationCall = (
  req: GlossAdjudicationRequest,
) => Promise<{ response: unknown; tokens: number }>;

export interface RunOptions {
  store: AdjudicationStore;
  call: AdjudicationCall;
  /** Words to process, in priority order. */
  requests: GlossAdjudicationRequest[];
  maxRetries?: number;
  /** Stop after this many NEW calls (cost control). */
  limit?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface RunSummary {
  calls: number;
  cached: number;
  failed: number;
  tokens: number;
  rateLimitedStop: boolean;
}

/** Rate-limit-aware batch loop: 429 → honour retry-after or back off
 * exponentially (2s … 60s); after `maxRetries` in a row it stops cleanly so a
 * later run resumes where this one left off. */
export async function runAdjudication(opts: RunOptions): Promise<RunSummary> {
  const { store, call, requests, maxRetries = 5, limit = Infinity } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => undefined);
  const summary: RunSummary = { calls: 0, cached: 0, failed: 0, tokens: 0, rateLimitedStop: false };

  for (const req of requests) {
    const hash = requestHash(req);
    if (store.get(req.word.id, hash)) {
      summary.cached++;
      continue;
    }
    if (summary.calls >= limit) break;

    let attempt = 0;
    for (;;) {
      try {
        const { response, tokens } = await call(req);
        summary.calls++;
        summary.tokens += tokens;
        store.append({ wordId: req.word.id, hash, response, tokens });
        break;
      } catch (err) {
        const status = err instanceof ProxyHttpError ? err.status : 0;
        if (status === 429 && attempt < maxRetries) {
          const wait =
            (err as ProxyHttpError).retryAfterMs ?? Math.min(60_000, 2000 * 2 ** attempt);
          log(
            `rate limited; waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(wait);
          attempt++;
          continue;
        }
        if (status === 429) {
          summary.rateLimitedStop = true;
          log('rate limit persists — stopping; re-run to resume');
          return summary;
        }
        summary.failed++;
        store.append({ wordId: req.word.id, hash, error: String(err).slice(0, 200) });
        log(`failed ${req.word.headword}: ${String(err).slice(0, 100)}`);
        break;
      }
    }
  }
  return summary;
}

/** The pipeline's client for apps/proxy's POST /v1/gloss. */
export function proxyCall(baseUrl: string, fetchImpl: typeof fetch = fetch): AdjudicationCall {
  return async (req) => {
    const res = await fetchImpl(`${baseUrl}/v1/gloss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'data-pipeline' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        retryAfterMs?: number;
      };
      throw new ProxyHttpError(body.error ?? `HTTP ${res.status}`, res.status, body.retryAfterMs);
    }
    return { response: await res.json(), tokens: Number(res.headers.get('x-total-tokens') ?? 0) };
  };
}
