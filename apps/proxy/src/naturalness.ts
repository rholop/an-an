// Phase 25 Part D naturalness pass, Phase 33 Part B: packs many lines per request, checks only
// lines not in the cache, and on the free quota running out stops at once, saves, and says when
// to run it again (exit 0), so a rerun resumes from the first unchecked line.
import { scriptQuotaStopMessage } from '@anan/core';
import { z } from 'zod';
import { QuotaExhaustedError } from './providers/types.js';

export interface NatLine {
  id: string;
  zh: string;
  en?: string;
  kind: 'sentence' | 'prompt-model';
}

export const NatVerdict = z.object({
  id: z.string(),
  natural: z.boolean(),
  reason: z.string().default(''),
  rewrite: z.string().default(''),
});
export const NatReply = z.object({ results: z.array(NatVerdict) });
export type NatVerdictT = z.infer<typeof NatVerdict>;

/** Keyed by the line's text. `model` = which Gemini model checked it (Phase 33). */
export type NatCache = Record<string, Omit<NatVerdictT, 'id'> & { model?: string }>;

/** Lines per request (Phase 33: 50; a few thousand characters, far under any input limit). */
export const NATURALNESS_BATCH = 50;
/** Other failures in a row before the run stops (so it never logs the same failure batch after batch). */
const MAX_FAILURES_IN_A_ROW = 3;

export interface NaturalnessDeps {
  /** One request: the verdicts and the model that answered. */
  check(lines: NatLine[]): Promise<{ results: NatVerdictT[]; model: string }>;
  saveCache(cache: NatCache): void;
  log(line: string): void;
  now(): Date;
}

export interface NaturalnessResult {
  calls: number;
  /** Lines with a verdict (of all lines). */
  checked: number;
  total: number;
  stopped?: 'quota' | 'max-calls' | 'failures';
  resetsAt?: Date;
}

/** Lines still to check: not in the cache, one per distinct text. */
export function linesToCheck(lines: readonly NatLine[], cache: NatCache): NatLine[] {
  return [...new Map(lines.filter((l) => !cache[l.zh]).map((l) => [l.zh, l])).values()];
}

export function naturalnessStatus(lines: readonly NatLine[], cache: NatCache, batch = NATURALNESS_BATCH): string {
  const left = linesToCheck(lines, cache).length;
  const checked = lines.filter((l) => cache[l.zh]).length;
  const byModel = new Map<string, number>();
  for (const l of lines) if (cache[l.zh]) byModel.set(cache[l.zh]!.model ?? 'unknown', (byModel.get(cache[l.zh]!.model ?? 'unknown') ?? 0) + 1);
  const models = [...byModel].map(([m, n]) => `${m} ${n}`).join(', ');
  return `${lines.length} lines: ${checked} checked${models ? ` (${models})` : ''}, ${left} distinct left (${Math.ceil(left / batch)} requests of ${batch}).`;
}

export async function runNaturalness(
  lines: readonly NatLine[],
  cache: NatCache,
  deps: NaturalnessDeps,
  opts: { batch?: number; maxCalls?: number; timeZone?: string } = {},
): Promise<NaturalnessResult> {
  const batchSize = opts.batch ?? NATURALNESS_BATCH;
  const todo = linesToCheck(lines, cache);
  const checkedNow = () => lines.filter((l) => cache[l.zh]).length;
  const result: NaturalnessResult = { calls: 0, checked: checkedNow(), total: lines.length };
  let failures = 0;
  deps.log(`${lines.length} lines, ${todo.length} to check, ${batchSize} per request`);
  for (let i = 0; i < todo.length; i += batchSize) {
    if (opts.maxCalls !== undefined && result.calls >= opts.maxCalls) {
      result.stopped = 'max-calls';
      deps.log(`Stopped after ${result.calls} requests (--max-calls). Checked ${checkedNow()} of ${lines.length} lines; run again to continue.`);
      break;
    }
    const batch = todo.slice(i, i + batchSize);
    result.calls++;
    try {
      const { results, model } = await deps.check(batch);
      for (const r of results) {
        const l = batch.find((x) => x.id === r.id);
        if (l) cache[l.zh] = { natural: r.natural, reason: r.reason, rewrite: r.rewrite, model };
      }
      deps.saveCache(cache);
      failures = 0;
      deps.log(`  ${Math.min(i + batchSize, todo.length)}/${todo.length} (${model})`);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        result.calls--; // nothing reached a model
        result.stopped = 'quota';
        result.resetsAt = e.resetsAt;
        deps.saveCache(cache);
        deps.log(
          scriptQuotaStopMessage({
            done: checkedNow(),
            total: lines.length,
            unit: 'lines',
            resetsAt: e.resetsAt,
            now: deps.now(),
            ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
          }),
        );
        break;
      }
      deps.log(`  batch at ${i} failed: ${(e as Error).message}`);
      if (++failures >= MAX_FAILURES_IN_A_ROW) {
        result.stopped = 'failures';
        deps.log(`Stopped: ${failures} requests in a row failed. Checked ${checkedNow()} of ${lines.length} lines; run again to continue.`);
        break;
      }
    }
  }
  result.checked = checkedNow();
  return result;
}

const MODEL_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          natural: { type: 'boolean' },
          reason: { type: 'string' },
          rewrite: { type: 'string' },
        },
        required: ['id', 'natural'],
      },
    },
  },
  required: ['results'],
} as const;

export const NATURALNESS_PROMPT = `You are a native speaker of Taiwan Mandarin checking sentences for a beginner textbook course.
For each line, decide whether a Taiwanese speaker would naturally say or write it (traditional characters,
Taiwan vocabulary and usage). Simple is fine; flag only lines that are ungrammatical, unidiomatic, mainland
usage, or that do not mean the English given. For a flagged line give a short reason in English and a
natural rewrite that keeps the same words where possible. Reply as JSON:
{"results":[{"id":"…","natural":true|false,"reason":"…","rewrite":"…"}]} with one result per input id.`;

/** The JSON task for one batch (for geminiForScript().run). */
export function naturalnessRequest(lines: readonly NatLine[]) {
  return {
    task: 'naturalness',
    systemPrompt: NATURALNESS_PROMPT,
    userMessage: `Lines:\n${JSON.stringify(lines.map((l) => ({ id: l.id, zh: l.zh, en: l.en ?? '' })))}`,
    jsonSchema: MODEL_SCHEMA,
    parse: (raw: unknown) => NatReply.parse(raw),
  };
}
