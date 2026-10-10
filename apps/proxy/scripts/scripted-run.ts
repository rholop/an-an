#!/usr/bin/env tsx
// Phase 3 acceptance criterion: "In a scripted run of 20 turns per scenario
// at L1, >= 90% of final replies meet the coverage threshold; the rest are
// shown with inline glosses. Report attempts and cost per turn in the dev
// drawer." This is that script, run directly against the real orchestrator
// + validator (no HTTP, no apps/web) so it exercises exactly the regenerate-
// on-fail loop ChatService uses.
//
// Needs GEMINI_API_KEY in the environment (or
// apps/proxy/.env) to hit a real model. Without one, pass --fake to run
// against a small set of canned scenario-appropriate replies instead — that
// proves the harness, reporting, and attempts/cost accounting work, but
// says nothing about a real model's actual pass rate (the canned replies
// are hand-picked to mostly pass, with one deliberately bad one per
// scenario to prove the regeneration + inline-gloss path still fires).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEVEL_IDS,
  analyzeText,
  Lexicon,
  resolveScenarioVocabExtraIds,
  type AnalyzeContext,
  type Level,
  type Scenario,
  type TurnHistoryEntry,
  type TurnResponse,
} from '@anan/core';
import { loadEnv, resolveChains } from '../src/env.js';
import {
  buildEffectiveSystemPrompt,
  createOrchestrator,
  type Orchestrator,
} from '../src/orchestrator.js';
import { buildSystemPrompt, loadPromptTemplate } from '../src/prompt.js';
import { PromptCache } from '../src/cache.js';
import { GeminiAdapter } from '../src/providers/gemini.js';
import type { ProviderAdapter, ProviderResult } from '../src/providers/types.js';
import { loadScenarioStore } from '../src/scenarios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const TURNS_PER_SCENARIO = 20;
const LEVEL: Level = 'L1';
const MAX_REGENERATIONS = 2;

const FAKE = process.argv.includes('--fake');

/** Hand-picked Taiwan Mandarin replies per scenario, cycled turn to turn.
 * Mostly clean (should pass); one per scenario has a simplified character
 * so checkTaiwanness fails it, proving the report distinguishes real
 * failures from a model that's simply never wrong. */
const FAKE_REPLIES: Record<string, { zh: string; bad?: boolean }[]> = {
  'tea-shop': [
    { zh: '好的，請問需要加大杯嗎？' },
    { zh: '少冰微糖，大杯外帶，一共三十五元。' },
    { zh: '謝謝光臨，祝你有美好的一天。' },
    { zh: '好的，这个很好喝，要不要试试看？', bad: true },
  ],
  'easycard-topup': [
    { zh: '好的，請問要加值多少錢？' },
    { zh: '請問要用現金還是信用卡？' },
    { zh: '餘額是五百元，謝謝您。' },
    { zh: '好的，没问题，马上帮您处理。', bad: true },
  ],
};

class ScriptedFakeAdapter implements ProviderAdapter {
  private i = 0;
  constructor(
    public readonly model: string,
    private readonly replies: { zh: string; bad?: boolean }[],
  ) {}

  async generateTurn(systemPrompt: string, history: TurnHistoryEntry[]): Promise<ProviderResult> {
    const reply = this.replies[this.i % this.replies.length]!;
    this.i++;
    const response: TurnResponse = {
      reply_zh: reply.zh,
      reply_en: '(fake run — no real translation)',
      tokens: [],
      targets_used: [],
      suggested_replies: [],
      goal_progress: [],
    };
    const approxInput = Math.round((systemPrompt.length + JSON.stringify(history).length) / 4);
    return {
      response,
      model: this.model,
      usage: { inputTokens: approxInput, outputTokens: Math.round(reply.zh.length / 2) },
    };
  }
}

function loadLexicon(): Lexicon {
  const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data/build/lexicon.v2.json'), 'utf8'));
  return new Lexicon(raw.words, raw.grammar);
}

function buildAnalyzeContext(lexicon: Lexicon, scenario: Scenario): AnalyzeContext {
  const LEVEL_ORDER: readonly Level[] = LEVEL_IDS;
  const atOrBelowLevel = LEVEL_ORDER.slice(0, LEVEL_ORDER.indexOf(LEVEL) + 1);
  // Stand-in "L1 learner": everything at/below L1 counts as known. A real
  // run would pull this from an actual learner's knownSet()/dueCards(), but
  // this script's job is to QA the proxy+validator pipeline, not simulate a
  // specific learner.
  const knownIds = new Set(
    lexicon
      .allWords()
      .filter((w) => w.level && atOrBelowLevel.includes(w.level))
      .map((w) => w.id),
  );
  const { ids: allowedExtraIds } = resolveScenarioVocabExtraIds(scenario, lexicon);
  return {
    lexicon,
    learnerLevel: LEVEL,
    knownIds,
    dueIds: new Set(),
    targetIds: new Set(),
    learningIds: new Set(),
    allowedExtraIds: new Set(allowedExtraIds),
  };
}

interface TurnReport {
  turn: number;
  provider: string;
  cached: boolean;
  tokens: number;
  attempts: number;
  coverage: number;
  pass: boolean;
}

async function runScenario(
  scenario: Scenario,
  lexicon: Lexicon,
  orchestrator: Orchestrator,
  promptTemplate: string,
): Promise<TurnReport[]> {
  const ctx = buildAnalyzeContext(lexicon, scenario);
  const history: TurnHistoryEntry[] = [
    { role: 'npc', zh: scenario.opener.zh, en: scenario.opener.en },
  ];
  const reports: TurnReport[] = [];

  for (let turn = 1; turn <= TURNS_PER_SCENARIO; turn++) {
    history.push({ role: 'learner', zh: '（模擬學習者回覆）' });

    const baseSystemPrompt = buildSystemPrompt(promptTemplate, scenario, {
      scenarioId: scenario.id,
      npcId: scenario.npc.id,
      history,
      learnerLevel: LEVEL,
      vocab: { knownSample: [], due: [], targets: [], allowedExtras: [] },
      scaffolding: 'high',
      englishFallback: false,
    });

    let attempts = 0;
    let feedback: string | undefined;
    let lastResult:
      { result: ProviderResult; log: Awaited<ReturnType<Orchestrator['run']>>['log'] } | undefined;
    let pass = false;
    let coverage = 0;

    while (attempts <= MAX_REGENERATIONS) {
      attempts++;
      const systemPrompt = buildEffectiveSystemPrompt(baseSystemPrompt, feedback);
      lastResult = await orchestrator.run(systemPrompt, history);
      const analysis = analyzeText(lastResult.result.response.reply_zh, ctx);
      pass = analysis.pass;
      coverage = analysis.coverage;
      if (pass) break;
      feedback = `Your last reply used out-of-level or non-Taiwan text. Coverage was ${(coverage * 100).toFixed(0)}%. Try again, simpler.`;
    }

    history.push({ role: 'npc', zh: lastResult!.result.response.reply_zh });
    reports.push({
      turn,
      provider: lastResult!.log.model,
      cached: lastResult!.log.cached,
      tokens: lastResult!.log.usage.inputTokens + lastResult!.log.usage.outputTokens,
      attempts,
      coverage,
      pass,
    });
  }

  return reports;
}

function printReport(scenarioId: string, reports: TurnReport[]): void {
  console.log(`\n=== ${scenarioId} ===`);
  console.log('turn  model     cached  tokens  attempts  coverage  pass');
  for (const r of reports) {
    console.log(
      `${String(r.turn).padStart(4)}  ${r.provider.padEnd(8)}  ${String(r.cached).padEnd(6)}  ${String(r.tokens).padStart(6)}  ${String(r.attempts).padStart(8)}  ${(r.coverage * 100).toFixed(0).padStart(7)}%  ${r.pass ? 'pass' : 'FAIL (shown w/ gloss)'}`,
    );
  }
  const passCount = reports.filter((r) => r.pass).length;
  const passRate = (passCount / reports.length) * 100;
  const totalTokens = reports.reduce((s, r) => s + r.tokens, 0);
  console.log(
    `-- ${scenarioId}: ${passCount}/${reports.length} passed (${passRate.toFixed(1)}%), ${totalTokens} tokens total --`,
  );
}

async function main(): Promise<void> {
  const env = loadEnv();
  const lexicon = loadLexicon();
  const scenarioStore = loadScenarioStore();
  const promptTemplate = loadPromptTemplate(env.PROMPT_VERSION);

  let primary: ProviderAdapter;
  let fallback: ProviderAdapter;

  if (FAKE) {
    console.log(
      "(--fake: using canned scenario replies, not a real model — see this script's header comment)",
    );
    primary = new ScriptedFakeAdapter('fake-primary', []); // overridden per-scenario below
    fallback = new ScriptedFakeAdapter('fake-fallback', []);
  } else {
    if (!env.GEMINI_API_KEY) {
      console.error('No GEMINI_API_KEY set, and --fake not passed. Nothing to run against.');
      console.error('Set it in apps/proxy/.env, or run with --fake for a dry run of the harness itself.');
      process.exit(1);
    }
    const [first, second] = resolveChains(env).turn;
    primary = new GeminiAdapter(env.GEMINI_API_KEY, first!);
    fallback = new GeminiAdapter(env.GEMINI_API_KEY, second ?? first!);
  }

  for (const scenario of scenarioStore.all()) {
    if (FAKE) {
      primary = new ScriptedFakeAdapter(
        'fake-primary',
        FAKE_REPLIES[scenario.id] ?? [{ zh: scenario.opener.zh }],
      );
      fallback = new ScriptedFakeAdapter(
        'fake-fallback',
        FAKE_REPLIES[scenario.id] ?? [{ zh: scenario.opener.zh }],
      );
    }
    const orchestrator = createOrchestrator(primary, fallback, new PromptCache());
    const reports = await runScenario(scenario, lexicon, orchestrator, promptTemplate);
    printReport(scenario.id, reports);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
