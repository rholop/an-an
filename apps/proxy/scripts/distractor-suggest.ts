/**
 * Phase 48 Part A.2: the optional Gemini helper pass behind `pnpm build:distractors --suggest`.
 * Asks the turn chain (free tier, batch reserve, the proxy's quota tracker) for "plausible but
 * wrong" same-length meaning neighbours, 50 words per request, checks every suggestion in code and
 * caches the ones that pass in data/build/distractor-suggestions.v1.json (committed). Resumable.
 *
 *   pnpm build:distractors --suggest                 # ask, then rebuild the table
 *   pnpm build:distractors --status                  # words asked and left, no calls
 *   pnpm build:distractors --suggest --max-calls 5 --model gemini-2.5-flash-lite
 *
 * Without a key it says so and exits 0: the table still builds from the code-only axes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStudyableForDistractors, type DistractorSuggestions, type Word } from '@anan/core';
import { runSuggest, suggestRequest, suggestStatus, SUGGEST_BATCH } from '../src/distractor-suggest.js';
import { geminiForScript, modelFlag } from '../src/script-gemini.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const num = (flag: string) => {
  const at = argv.indexOf(flag);
  const n = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};
const cacheFile = path.join(root, 'data/build/distractor-suggestions.v1.json');

const lexicon = JSON.parse(readFileSync(path.join(root, 'data/build/lexicon.v2.json'), 'utf8')) as { words: Word[] };
const words = lexicon.words.filter(isStudyableForDistractors);
const byHeadword = new Map<string, Word>();
for (const w of lexicon.words) if (w.source !== 'supplement' && !byHeadword.has(w.headword)) byHeadword.set(w.headword, w);
const cache: DistractorSuggestions = existsSync(cacheFile)
  ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as DistractorSuggestions)
  : { version: 1, words: {} };
const batch = num('--batch') ?? SUGGEST_BATCH;

if (argv.includes('--status')) {
  console.log(suggestStatus(words, cache, batch));
} else {
  let gemini;
  try {
    gemini = geminiForScript({ role: 'turn', ...(modelFlag(argv) ? { model: modelFlag(argv)! } : {}) });
  } catch (e) {
    console.log(`${(e as Error).message}: no suggestions asked; the table builds from the code-only axes.`);
    process.exit(0);
  }
  console.log(`Asking ${gemini.chain.join(' → ')} (models out of free quota are skipped)`);
  const maxCalls = num('--max-calls');
  await runSuggest(
    words,
    byHeadword,
    cache,
    {
      ask: async (b) => {
        const r = await gemini.run(suggestRequest(b));
        return { results: r.response.results, model: r.model };
      },
      save: (c) =>
        writeFileSync(
          cacheFile,
          `{"version":1,"words":{\n${Object.entries(c.words)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([id, e]) => `${JSON.stringify(id)}:${JSON.stringify(e)}`)
            .join(',\n')}\n}}\n`,
        ),
      log: (line) => console.log(line),
      now: () => new Date(),
    },
    { batch, ...(maxCalls ? { maxCalls } : {}) },
  );
  console.log(suggestStatus(words, cache, batch));
}
