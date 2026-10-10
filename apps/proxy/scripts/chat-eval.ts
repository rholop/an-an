/**
 * Phase 36 Part E.3: the chat eval. 20 scripted learner turns (facts, typos, gaps) through both
 * chat modes, with the app's own turn loop (`runChatTurn`), against a LIVE proxy. Writes
 * docs/chat-eval.md: how often a reply contradicts what the learner said, and the corrector's
 * precision on the typo set.
 *
 *   pnpm --filter @anan/proxy dev   # one terminal (needs GEMINI_API_KEY)
 *   pnpm eval:chat                  # another
 *
 * Env: PROXY_URL (default http://localhost:3002), SITE_CODE (the household code).
 * Every request is a batch request; the free quota running out ends the run cleanly.
 * `--model <name>` pins one Gemini model (to compare models on the turn chain).
 * `--dry` runs the harness with offline stand-ins (no keys) and writes the report marked as a
 * DRY RUN: it proves the harness, it is not model output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatMeaningCheckResponseSchema,
  dryChatEvalModels,
  JournalReviewSchema,
  renderChatEvalReport,
  runChatEval,
  summarizeChatEval,
  TurnResponseSchema,
  type ChatEvalConversation,
  type ChatEvalModels,
  type Word,
} from '@anan/core';
import { exitOnQuotaStop, postAsBatch } from '../src/script-proxy.js';
import { modelFlag } from '../src/script-gemini.js';
import { loadScenarioStore } from '../src/scenarios.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const proxyUrl = process.env.PROXY_URL ?? 'http://localhost:3002';
const dry = process.argv.includes('--dry');
const model = modelFlag(process.argv);
const LEVEL = 'N2' as const;

async function post(route: string, body: unknown): Promise<unknown> {
  const res = await postAsBatch(`${proxyUrl}${route}`, body, { installId: 'chat-eval', model }).catch((err: unknown) =>
    exitOnQuotaStop(err),
  );
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

function liveModels(): ChatEvalModels {
  const lex = JSON.parse(readFileSync(path.join(root, 'data/build/lexicon.v2.json'), 'utf8')) as { words: Word[] };
  // A beginner's words: the novice bands, which the script's turns are written in.
  const known = [...new Set(lex.words.filter((w) => w.level === 'N1' || w.level === 'N2').map((w) => w.headword))];
  const scenarios = loadScenarioStore();
  const vocabFor = (conv: ChatEvalConversation) => ({
    knownSample: known.slice(0, 400),
    due: [],
    targets: [],
    allowedExtras: scenarios.get(conv.scenarioId)?.vocabExtras ?? [],
  });
  return {
    async reply(mode, conv, history, extra) {
      const common = {
        history,
        learnerLevel: LEVEL,
        scaffolding: 'medium' as const,
        englishFallback: true,
        facts: extra.facts.slice(-24),
        ...(extra.feedback ? { feedback: extra.feedback } : {}),
        ...(extra.alternateModel ? { alternateModel: true } : {}),
      };
      const body =
        mode === 'scenario'
          ? {
              ...common,
              scenarioId: conv.scenarioId,
              npcId: scenarios.get(conv.scenarioId)?.npc.id ?? 'npc',
              vocab: vocabFor(conv),
            }
          : { ...common, mode: 'open', topic: conv.topic, tiers: { a: known.slice(0, 400), b: [], cAllowed: [] } };
      return TurnResponseSchema.parse(await post('/v1/turn', body));
    },
    async correct(text, context) {
      const review = JournalReviewSchema.parse(
        await post('/v1/journal-review', {
          text,
          learnerLevel: LEVEL,
          promptWords: [],
          recurringPatterns: [],
          maxIssues: 3,
          chatContext: context.slice(-12),
        }),
      );
      return {
        issues: review.issues.map((i) => ({ original: text.slice(i.span[0], i.span[1]), correction: i.correction })),
      };
    },
    async checkMeaning(req) {
      return ChatMeaningCheckResponseSchema.parse(await post('/v1/chat-meaning-check', req));
    },
  };
}

const results = await runChatEval(dry ? dryChatEvalModels() : liveModels(), {
  onTurn: (r) => console.log(`${r.mode} ${r.conversation}: ${r.contradicted ? 'CONTRADICTS' : 'ok'} · ${r.reply}`),
});
const report = renderChatEvalReport(results, {
  source: dry ? 'DRY RUN, offline stand-ins (NOT model output)' : proxyUrl,
  date: new Date().toISOString().slice(0, 10),
  ...(model ? { chain: model } : {}),
});
const decision = [
  '',
  '## Model chain decision',
  '',
  dry
    ? 'Kept the Phase 33 turn chain unchanged: this report is a dry run, so it shows no model doing better. Run `pnpm eval:chat` live (and `--model <name>` per candidate) and change `GEMINI_CHAIN_TURN` only if another free-tier model contradicts the learner less often.'
    : 'Compare this run with one per candidate model (`--model <name>`). Change `GEMINI_CHAIN_TURN` only if another model contradicts the learner less often; otherwise keep it and note that here.',
  '',
].join('\n');
writeFileSync(path.join(root, 'docs/chat-eval.md'), report + decision);
for (const mode of ['scenario', 'open'] as const) {
  const s = summarizeChatEval(results.filter((r) => r.mode === mode));
  console.log(`${mode}: ${s.contradicted}/${s.turns} contradicted, typos ${s.typosFixed}/${s.typoTurns}, precision ${(s.precision * 100).toFixed(0)}%`);
}
console.log('wrote docs/chat-eval.md');
