/**
 * Phase 17 Part F: runs packages/core/test/fixtures/journal-cloze/sentences.v1.json
 * through the REAL pipeline (review -> verify -> build items -> solver test) against a
 * LIVE proxy (real models) and writes docs/journal-cloze-eval.md, with a blank verdict
 * per item for a human to fill in. Re-run before every prompt change and diff the result.
 *
 *   pnpm --filter @anan/proxy dev   # one terminal (needs GEMINI_API_KEY)
 *   pnpm eval:journal               # another
 *
 * Env: PROXY_URL (default http://localhost:3002), SITE_CODE (the household code).
 * `--dry` runs the same harness with offline stand-ins built from the fixtures' own
 * reference corrections (no keys needed) and prints a summary instead of writing the
 * baseline: it proves the harness, it is not model output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dryEvalModels,
  JournalSolveResponseSchema,
  JournalVerifyResponseSchema,
  JournalReviewSchema,
  Lexicon,
  ModelSentenceReviewSchema,
  ProviderNameSchema,
  renderEvalReport,
  runJournalClozeEval,
  type EvalFixtureFile,
  type EvalReviewer,
  type GrammarItem,
  type JournalLLM,
  type Word,
} from '@anan/core';
import { exitOnQuotaStop, postAsBatch } from '../src/script-proxy.js';
import { modelFlag } from '../src/script-gemini.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const proxyUrl = process.env.PROXY_URL ?? 'http://localhost:3002';
const dry = process.argv.includes('--dry');

const file = JSON.parse(
  readFileSync(path.join(root, 'packages/core/test/fixtures/journal-cloze/sentences.v1.json'), 'utf8'),
) as EvalFixtureFile;
const lexFile = JSON.parse(readFileSync(path.join(root, 'data/build/lexicon.v2.json'), 'utf8')) as {
  words: Word[];
  grammar: GrammarItem[];
};
const lexicon = new Lexicon(lexFile.words, lexFile.grammar);

async function post(route: string, body: unknown): Promise<{ json: unknown; servedBy?: string }> {
  // Phase 33: a batch request; the free quota running out ends the run (exit 0)
  const res = await postAsBatch(`${proxyUrl}${route}`, body, { installId: 'journal-cloze-eval', model: modelFlag(process.argv) }).catch(
    (err: unknown) => exitOnQuotaStop(err),
  );
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  const served = ProviderNameSchema.safeParse(res.headers.get('x-served-by'));
  return { json: await res.json(), servedBy: served.success ? served.data : undefined };
}

const live: { llm: JournalLLM; review: EvalReviewer } = {
  review: async (sentences, protectedTerms) => {
    const { json, servedBy } = await post('/v1/journal-review', {
      text: sentences.join(''),
      learnerLevel: file.learnerLevel,
      promptWords: [],
      recurringPatterns: [],
      maxIssues: 1,
      sentences,
      protectedTerms,
      sentencesOnly: true,
    });
    return { reviews: JournalReviewSchema.parse(json).sentences ?? [], servedBy };
  },
  llm: {
    async fixJournalSentence(req) {
      const { json, servedBy } = await post('/v1/journal-sentence-fix', req);
      return { review: ModelSentenceReviewSchema.parse(json), servedBy };
    },
    async verifyJournalSentence(req) {
      return JournalVerifyResponseSchema.parse((await post('/v1/journal-verify', req)).json);
    },
    async solveJournalCloze(req) {
      return JournalSolveResponseSchema.parse((await post('/v1/journal-solve', req)).json);
    },
  },
};

const models = dry ? dryEvalModels(file) : live;
const results = await runJournalClozeEval(file, { lexicon, now: new Date(), ...models });
const report = renderEvalReport(results, {
  generatedAt: new Date().toISOString(),
  source: dry ? 'an offline dry run (NOT model output)' : proxyUrl,
  promptVersion: process.env.PROMPT_VERSION ?? 'v1',
});

const violations = results.flatMap((r) => r.violations.map((v) => `${r.fixture.id}: ${v}`));
if (dry) {
  const verified = results.filter((r) => r.verified?.status === 'verified').length;
  console.log(
    `dry run: ${results.length} sentences, ${verified} verified, ${results.reduce((n, r) => n + r.items.length, 0)} items, ${violations.length} violations`,
  );
  if (process.argv.includes('--write-dry'))
    writeFileSync(path.join(root, 'docs/journal-cloze-eval.dry-run.md'), report);
} else {
  writeFileSync(path.join(root, 'docs/journal-cloze-eval.md'), report);
  console.log('wrote docs/journal-cloze-eval.md');
}
if (violations.length > 0) {
  console.error(`HARD-RULE VIOLATIONS:\n${violations.join('\n')}`);
  process.exit(1);
}
