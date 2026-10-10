// Phase 36 Part E.3: the chat eval. 20 scripted learner turns with facts, typos and gaps, run
// through both chat modes (scenario and open) by the same turn loop the app uses (runChatTurn).
// It reports how often a final reply contradicts what the learner said and how precise the
// corrector is on the typo set. The script (apps/proxy/scripts/chat-eval.ts) supplies the live
// model calls; `dryChatEvalModels` are offline stand-ins that prove the harness only.
import { checkReplyMeaning, mergeFacts, runChatTurn, judgeReplyMeaning, type ChatTurnDeps, type ChatTurnValidation } from './listen.js';
import type { ChatMeaningCheckRequest, ChatMeaningCheckResponse, TurnResponse } from './types.js';

export interface ChatEvalTurn {
  zh: string;
  /** What the learner said about themselves ("subject: fact"), the ground truth for contradictions. */
  facts: string[];
  /** A typo the corrector should fix (wrong → right). */
  typo?: { wrong: string; right: string };
  /** An English gap the reply should understand. */
  gap?: string;
}

export interface ChatEvalConversation {
  id: string;
  /** Scenario chat runs it in this scenario; open chat with this topic. */
  scenarioId: string;
  topic: string;
  turns: ChatEvalTurn[];
}

export const CHAT_EVAL_SCRIPT: readonly ChatEvalConversation[] = [
  {
    id: 'family',
    scenarioId: 'laixue-1-L04-parents-jobs',
    topic: 'family',
    turns: [
      { zh: '我爸爸在學校工作含我媽媽不工作。', facts: ['father: works at a school', "mother: doesn't work"], typo: { wrong: '含', right: '和' } },
      { zh: '我爸爸每天很忙。我媽媽喜歡【gardening】。', facts: ['father: busy every day', 'mother: likes gardening'], gap: 'gardening' },
      { zh: '她每天在家種花。', facts: ['mother: grows flowers at home every day'] },
      { zh: '我哥哥是醫生，他在台北工做。', facts: ['older brother: is a doctor', 'older brother: works in Taipei'], typo: { wrong: '工做', right: '工作' } },
      { zh: '我沒有姐姐。', facts: ["me: doesn't have an older sister"] },
      { zh: '我弟弟還是學生，他十六歲。', facts: ['younger brother: is a student', 'younger brother: is 16'] },
      { zh: '我的家人都很喜歡喝茶。', facts: ['me: my family all like tea'] },
    ],
  },
  {
    id: 'weekend',
    scenarioId: 'laixue-1-L06-weekend-hobbies',
    topic: 'my weekend',
    turns: [
      { zh: '我週末常常去【hiking】。', facts: ['me: often goes hiking on weekends'], gap: 'hiking' },
      { zh: '我不喜歡吃辣的。', facts: ["me: doesn't like spicy food"] },
      { zh: '昨天我跟朋友去吃牛肉麵，很好吃。', facts: ['me: ate beef noodles with a friend yesterday'] },
      { zh: '我住在台中，不住在台北。', facts: ['me: lives in Taichung', "me: doesn't live in Taipei"] },
      { zh: '我的朋友叫小明，他是工程師。', facts: ['friend: is called 小明', 'friend: is an engineer'] },
      { zh: '我在學中文，因為我先生是台灣人。', facts: ['me: is learning Chinese', 'husband: is Taiwanese'] },
      { zh: '我很喜歡喝咖啡，可是我先生不喝咖啡。', facts: ['me: likes coffee', "husband: doesn't drink coffee"] },
    ],
  },
  {
    id: 'day',
    scenarioId: 'laixue-1-L06-weekend-hobbies',
    topic: 'my day',
    turns: [
      { zh: '我明天要去買東西，你要不要一起去？', facts: ['me: is going shopping tomorrow'] },
      { zh: '我今天很累，因為我昨天睡的很晚。', facts: ['me: is tired today', 'me: went to bed late yesterday'], typo: { wrong: '的', right: '得' } },
      { zh: '我在便利商店買了一瓶水。', facts: ['me: bought a bottle of water at a convenience store'] },
      { zh: '我的老師中文說得很好，她教了十年了。', facts: ['teacher: has taught for ten years'] },
      { zh: '我想要學作菜。', facts: ['me: wants to learn to cook'], typo: { wrong: '作菜', right: '做菜' } },
      { zh: '我的狗很可愛，牠喜歡在公園跑步。', facts: ['dog: likes running in the park'] },
    ],
  },
];

/** The corrector's answer for one message (the journal review's issues, reduced). */
export interface ChatEvalCorrection {
  issues: Array<{ original: string; correction: string }>;
}

export interface ChatEvalModels {
  /** One chat reply in a mode (the app's request, built by the script). */
  reply(
    mode: 'scenario' | 'open',
    conversation: ChatEvalConversation,
    history: Array<{ role: 'npc' | 'learner'; zh: string }>,
    extra: { feedback?: string; alternateModel?: boolean; facts: string[] },
  ): Promise<TurnResponse>;
  correct(text: string, context: Array<{ role: 'npc' | 'learner'; zh: string }>): Promise<ChatEvalCorrection>;
  checkMeaning?(req: ChatMeaningCheckRequest): Promise<ChatMeaningCheckResponse>;
}

export interface ChatEvalTurnResult {
  mode: 'scenario' | 'open';
  conversation: string;
  learner: string;
  reply: string;
  replyEn: string;
  readAs: string;
  attempts: number;
  /** The app's own meaning check still flagged it (shown with the warning). */
  warned: boolean;
  /** Judged against the script's ground-truth facts (code check, then the checker). */
  contradicted: boolean;
  contradictedFact?: string;
  corrections: ChatEvalCorrection['issues'];
  typo?: ChatEvalTurn['typo'];
  /** The typo was fixed (an issue whose original holds the wrong text and correction the right). */
  typoFixed?: boolean;
}

const pass: ChatTurnValidation = { pass: true, taiwanClean: true, feedback: '' };

/** Runs the whole script in both modes. `onTurn` sees each result as it lands (for resumable logs). */
export async function runChatEval(
  models: ChatEvalModels,
  opts: { modes?: Array<'scenario' | 'open'>; onTurn?: (r: ChatEvalTurnResult) => void } = {},
): Promise<ChatEvalTurnResult[]> {
  const out: ChatEvalTurnResult[] = [];
  for (const mode of opts.modes ?? (['scenario', 'open'] as const)) {
    for (const conv of CHAT_EVAL_SCRIPT) {
      const history: Array<{ role: 'npc' | 'learner'; zh: string }> = [];
      let facts: string[] = [];
      let truth: string[] = [];
      for (const turn of conv.turns) {
        history.push({ role: 'learner', zh: turn.zh });
        const [result, correction] = await Promise.all([
          runChatTurn({
            generate: (x) => models.reply(mode, conv, history, { ...x, facts }),
            validate: () => pass,
            ...(models.checkMeaning ? { checkMeaning: models.checkMeaning } : {}),
            facts,
            learnerMessage: turn.zh,
            maxRegenerations: 0,
            unreliable: () => new Error('no reliable reply'),
          } satisfies ChatTurnDeps<ChatTurnValidation>),
          models.correct(turn.zh, history.slice(0, -1)),
        ]);
        facts = result.facts;
        truth = mergeFacts(truth, turn.facts);
        const verdict = await judgeReplyMeaning(result.response, truth, turn.zh, models.checkMeaning);
        const r: ChatEvalTurnResult = {
          mode,
          conversation: conv.id,
          learner: turn.zh,
          reply: result.response.reply_zh,
          replyEn: result.response.reply_en,
          readAs: result.response.learner_meaning_en ?? '',
          attempts: result.attempts,
          warned: result.misunderstood,
          contradicted: verdict.verdict === 'contradicts',
          ...(verdict.verdict === 'contradicts' ? { contradictedFact: verdict.fact } : {}),
          corrections: correction.issues,
          ...(turn.typo
            ? {
                typo: turn.typo,
                typoFixed: correction.issues.some(
                  (i) => i.original.includes(turn.typo!.wrong) && i.correction.includes(turn.typo!.right),
                ),
              }
            : {}),
        };
        out.push(r);
        opts.onTurn?.(r);
        history.push({ role: 'npc', zh: result.response.reply_zh });
      }
    }
  }
  return out;
}

export interface ChatEvalSummary {
  turns: number;
  contradicted: number;
  warned: number;
  typoTurns: number;
  typosFixed: number;
  flags: number;
  /** Flags that fix a scripted typo, over all flags (the corrector's precision). */
  precision: number;
}

export function summarizeChatEval(results: readonly ChatEvalTurnResult[]): ChatEvalSummary {
  const flags = results.reduce((n, r) => n + r.corrections.length, 0);
  const good = results.filter((r) => r.typoFixed).length;
  return {
    turns: results.length,
    contradicted: results.filter((r) => r.contradicted).length,
    warned: results.filter((r) => r.warned).length,
    typoTurns: results.filter((r) => r.typo).length,
    typosFixed: good,
    flags,
    precision: flags === 0 ? 1 : good / flags,
  };
}

export function renderChatEvalReport(
  results: readonly ChatEvalTurnResult[],
  meta: { source: string; date: string; chain?: string },
): string {
  const lines: string[] = [
    '# Chat eval (Phase 36)',
    '',
    `Run: ${meta.date} · source: ${meta.source}${meta.chain ? ` · turn chain: ${meta.chain}` : ''}`,
    '',
    'Re-run with `pnpm eval:chat` against a live proxy (`--dry` for the offline harness check). Acceptance:',
    'facts contradicted in at most 1 of 20 turns per mode.',
    '',
  ];
  for (const mode of ['scenario', 'open'] as const) {
    const rs = results.filter((r) => r.mode === mode);
    if (rs.length === 0) continue;
    const s = summarizeChatEval(rs);
    lines.push(
      `## ${mode === 'scenario' ? 'Scenario chat' : 'Open chat'}`,
      '',
      `- Replies contradicting a stated fact: **${s.contradicted} of ${s.turns}** ${s.contradicted <= 1 ? '(meets the bar)' : '(misses the bar of 1)'}`,
      `- Shown with "may have misunderstood you": ${s.warned}`,
      `- Typos fixed: ${s.typosFixed} of ${s.typoTurns}; corrector precision ${(s.precision * 100).toFixed(0)}% (${s.flags} corrections in all)`,
      '',
      '| # | Learner | Reply | Read as | Corrections | Verdict |',
      '|---|---|---|---|---|---|',
      ...rs.map(
        (r, i) =>
          `| ${i + 1} | ${r.learner} | ${r.reply} | ${r.readAs.replace(/\|/g, '/')} | ${r.corrections.map((c) => `${c.original}→${c.correction}`).join(', ') || '✓'} | ${r.contradicted ? `✗ ${r.contradictedFact ?? ''}` : 'ok'}${r.typo ? (r.typoFixed ? ' · typo fixed' : ' · typo missed') : ''} |`,
      ),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * Offline stand-ins (no keys): a model that reads the script's own facts back and asks a
 * question, and a corrector that knows the scripted typos. They prove the harness and the report;
 * they are not model output.
 */
export function dryChatEvalModels(): ChatEvalModels {
  const byText = new Map(CHAT_EVAL_SCRIPT.flatMap((c) => c.turns.map((t) => [t.zh, t] as const)));
  return {
    async reply(_mode, _conv, history) {
      const last = history[history.length - 1]!;
      const turn = byText.get(last.zh);
      return {
        reply_zh: '真的嗎？然後呢？',
        reply_en: 'Really? And then?',
        tokens: [],
        targets_used: [],
        suggested_replies: [],
        goal_progress: [],
        learner_meaning_en: turn?.facts.join('; ') ?? '',
        learner_facts: turn?.facts ?? [],
      };
    },
    async correct(text) {
      const turn = byText.get(text);
      return { issues: turn?.typo ? [{ original: turn.typo.wrong, correction: turn.typo.right }] : [] };
    },
  };
}

/** For tests: the code half of the meaning check on one reply against a list of facts. */
export const evalCodeVerdict = checkReplyMeaning;
