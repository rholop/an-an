// Phase 48 Part A.2: the optional Gemini helper pass for `pnpm build:distractors --suggest`. Asks
// for up to 6 "plausible but wrong for this gloss" same-length Taiwan words per word, 50 words per
// request, as batch requests on the free tier (Phase 33). Every suggestion is checked in code
// (`checkSuggestion`: in the lexicon, same length, traditional, not also correct, not a name) and
// only the ones that pass are cached. On the quota running out it saves and stops (exit 0), so a
// rerun resumes with the words not asked yet.
import { checkSuggestion, glossFor, scriptQuotaStopMessage, type DistractorSuggestions, type Word } from '@anan/core';
import { z } from 'zod';
import { QuotaExhaustedError } from './providers/types.js';

export const SUGGEST_BATCH = 50;
export const SUGGEST_PER_WORD = 6;
const MAX_FAILURES_IN_A_ROW = 3;

export const SuggestReply = z.object({
  results: z.array(z.object({ id: z.string(), options: z.array(z.string()).default([]) })),
});

export const SUGGEST_PROMPT = `You write multiple-choice options for Taiwan Mandarin vocabulary practice.
For each word you get its English meaning. Give up to ${SUGGEST_PER_WORD} other Taiwan Mandarin words that a learner could
plausibly confuse with it: the SAME number of characters, the same part of speech and the same kind of meaning
(other desserts for 冰淇淋, other frequency words for 平常), but WRONG for the English meaning given. Never a
synonym or another way to say the same thing, never a name, traditional characters and Taiwan usage only.
Reply as JSON: {"results":[{"id":"…","options":["…"]}]} with one result per input id.`;

const MODEL_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
        required: ['id', 'options'],
      },
    },
  },
  required: ['results'],
} as const;

/** The JSON task for one batch (for geminiForScript().run). */
export function suggestRequest(words: readonly Word[]) {
  return {
    task: 'distractor-suggest',
    systemPrompt: SUGGEST_PROMPT,
    userMessage: `Words:\n${JSON.stringify(words.map((w) => ({ id: w.id, zh: w.headword, en: glossFor(w), pos: w.pos.join('/') })))}`,
    jsonSchema: MODEL_SCHEMA,
    parse: (raw: unknown) => SuggestReply.parse(raw),
  };
}

export interface SuggestDeps {
  ask(words: Word[]): Promise<{ results: Array<{ id: string; options: string[] }>; model: string }>;
  save(s: DistractorSuggestions): void;
  log(line: string): void;
  now(): Date;
}

export function suggestStatus(words: readonly Word[], cache: DistractorSuggestions, batch = SUGGEST_BATCH): string {
  const left = words.filter((w) => !cache.words[w.id]).length;
  const kept = Object.values(cache.words).reduce((n, e) => n + e.headwords.length, 0);
  return `${words.length} words: ${words.length - left} asked (${kept} checked suggestions kept), ${left} left (${Math.ceil(left / batch)} requests of ${batch}).`;
}

/** Ask for the words not in the cache yet; keep only suggestions that pass `checkSuggestion`. */
export async function runSuggest(
  words: readonly Word[],
  byHeadword: ReadonlyMap<string, Word>,
  cache: DistractorSuggestions,
  deps: SuggestDeps,
  opts: { batch?: number; maxCalls?: number } = {},
): Promise<{ calls: number; stopped?: 'quota' | 'max-calls' | 'failures' }> {
  const size = opts.batch ?? SUGGEST_BATCH;
  const todo = words.filter((w) => !cache.words[w.id]);
  let calls = 0;
  let failures = 0;
  deps.log(`${words.length} words, ${todo.length} to ask, ${size} per request`);
  for (let i = 0; i < todo.length; i += size) {
    if (opts.maxCalls !== undefined && calls >= opts.maxCalls) {
      deps.log(`Stopped after ${calls} requests (--max-calls); run again to continue.`);
      return { calls, stopped: 'max-calls' };
    }
    const batch = todo.slice(i, i + size);
    calls++;
    try {
      const { results, model } = await deps.ask(batch);
      for (const w of batch) {
        const options = results.find((r) => r.id === w.id)?.options ?? [];
        const kept = [...new Set(options.map((o) => o.trim()))].filter((h) => !checkSuggestion(w, h, byHeadword)).slice(0, SUGGEST_PER_WORD);
        cache.words[w.id] = { model, headwords: kept };
      }
      deps.save(cache);
      failures = 0;
      deps.log(`  ${Math.min(i + size, todo.length)}/${todo.length} (${model})`);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        deps.save(cache);
        deps.log(
          scriptQuotaStopMessage({ verb: 'Asked about', done: words.length - todo.length + i, total: words.length, unit: 'words', resetsAt: e.resetsAt, now: deps.now() }),
        );
        return { calls: calls - 1, stopped: 'quota' };
      }
      deps.log(`  batch at ${i} failed: ${(e as Error).message}`);
      if (++failures >= MAX_FAILURES_IN_A_ROW) {
        deps.log(`Stopped: ${failures} requests in a row failed; run again to continue.`);
        return { calls, stopped: 'failures' };
      }
    }
  }
  return { calls };
}
