/**
 * Phase 24 acceptance: 20 graded stories per level (Novice = N1, L1) on 5 topics, written and
 * checked through the REAL pipeline (`runStoryPipeline`: write → code checks → regenerate once →
 * independent check by the other provider) against a LIVE proxy, for two seeded learners. Writes
 * docs/stories-eval.md with every story that would be shown, its shares and a blank verdict line.
 *
 *   pnpm --filter @anan/proxy dev   # one terminal (needs GEMINI_API_KEY)
 *   pnpm eval:stories               # another
 *
 * Env: PROXY_URL (default http://localhost:3002), SITE_CODE (the household code).
 * `--dry` runs the same harness with the offline stand-in writer (no keys needed) and writes
 * docs/stories-eval.md marked as a DRY RUN: it proves the harness, it is not model output.
 * Exits 1 if any story that would be shown breaks a share or a check (a hard-rule violation).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STUDY_SETTINGS,
  dryStory,
  dryStoryCheck,
  getStudyFocus,
  Lexicon,
  promptBudget,
  ProviderNameSchema,
  STORY_CONFIG,
  storyBudget,
  storyLength,
  storyPromptRungs,
  StoryCheckResponseSchema,
  StoryResponseSchema,
  runStoryPipeline,
  vocabLadder,
  type GrammarItem,
  type Level,
  type SkillCard,
  type StoryDifficulty,
  type StoryLLM,
  type StoryPipelineResult,
  type StoryRequest,
  type Textbook,
  type Word,
} from '@anan/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const proxyUrl = process.env.PROXY_URL ?? 'http://localhost:3002';
const dry = process.argv.includes('--dry');
const PER_LEVEL = 20;
const DIFFICULTY: StoryDifficulty = 'middle';

const lexFile = JSON.parse(readFileSync(path.join(root, 'data/build/lexicon.v2.json'), 'utf8')) as {
  words: Word[];
  grammar: GrammarItem[];
};
const bookFiles = [1, 2, 3, 4].map(
  (n) =>
    JSON.parse(readFileSync(path.join(root, `apps/web/public/textbook/laixue-${n}/book.json`), 'utf8')) as {
      textbook: Textbook;
      grammarItems: GrammarItem[];
    },
);
const books = bookFiles.map((b) => b.textbook);
const lexicon = new Lexicon(lexFile.words, [...lexFile.grammar, ...bookFiles.flatMap((b) => b.grammarItems)]);

const NOW = new Date();
const card = (id: string, skill: 'recognition' | 'production'): SkillCard => ({
  item: { kind: 'word', id },
  skill,
  card: {
    due: new Date(NOW.getTime() + 20 * 86_400_000),
    stability: 30,
    difficulty: 5,
    elapsed_days: 10,
    scheduled_days: 30,
    learning_steps: 0,
    reps: 5,
    lapses: 0,
    state: 2,
    last_review: new Date(NOW.getTime() - 10 * 86_400_000),
  },
  state: 'mature',
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  clozeRung: 1,
  clozeStreak: 0,
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  updatedAt: NOW,
});

/**
 * The two seeded learners. Novice: class = 來學華語 1 Lesson 3 (Lessons 1–2 still catch-up), the 150
 * most frequent N1 words Learned. L1: N1 and N2 Mastered (so book 2 is not gated), book 1 Learned,
 * class = 來學華語 2 Lesson 3.
 */
function profile(level: Level) {
  const byFreq = (lv: Level) =>
    lexicon
      .allWords()
      .filter((w) => w.level === lv && w.source === 'tocfl')
      .sort((a, b) => (a.freqRank ?? 1e9) - (b.freqRank ?? 1e9));
  const known =
    level === 'N1'
      ? byFreq('N1').slice(0, 150).map((w) => w.id)
      : [
          ...byFreq('N1').map((w) => w.id),
          ...byFreq('N2').map((w) => w.id),
          ...books[0]!.lessons.flatMap((l) => l.vocab),
        ];
  const cards = [...new Set(known)].flatMap((id) => [card(id, 'recognition'), card(id, 'production')]);
  const focus = getStudyFocus(
    {
      lexicon,
      books,
      cards,
      grammarUses: new Map(),
      settings: { ...DEFAULT_STUDY_SETTINGS },
      myClass: { enabled: true, textbookId: level === 'N1' ? 'laixue-1' : 'laixue-2', currentLesson: 3 },
    },
    NOW,
  );
  const ladder = vocabLadder({
    lexicon,
    level,
    knownIds: new Set(known),
    dueIds: new Set(),
    learningIds: new Set(),
    books,
    studyFocus: focus,
  });
  return { ladder, lessonTopic: ladder.lessons.active ? `${ladder.lessons.active.titleEn}: ${ladder.lessons.active.topic}` : 'everyday life' };
}

const TOPICS = (lessonTopic: string) => [
  lessonTopic,
  'eating out in Taipei',
  'a rainy day',
  'shopping at a night market',
  'plans for the weekend',
];

async function post(route: string, body: unknown): Promise<{ json: unknown; servedBy?: string }> {
  const res = await fetch(`${proxyUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-install-id': 'stories-eval',
      'x-site-code': process.env.SITE_CODE ?? '',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  const served = ProviderNameSchema.safeParse(res.headers.get('x-served-by'));
  return { json: await res.json(), servedBy: served.success ? served.data : undefined };
}

const llm: StoryLLM = dry
  ? {
      writeStory: async (req) => ({ story: dryStory(req), servedBy: 'gemini' }),
      checkStory: async (req) => dryStoryCheck(req),
    }
  : {
      writeStory: async (req) => {
        const { json, servedBy } = await post('/v1/story', req);
        return { story: StoryResponseSchema.parse(json), ...(servedBy ? { servedBy } : {}) };
      },
      checkStory: async (req) => StoryCheckResponseSchema.parse((await post('/v1/story-check', req)).json),
    };

interface Row {
  level: Level;
  topic: string;
  n: number;
  result: StoryPipelineResult | { ok: false; reasons: string[]; attempts: []; error: string };
}

const rows: Row[] = [];
const violations: string[] = [];
const budget = storyBudget(DIFFICULTY);
for (const level of ['N1', 'L1'] as Level[]) {
  const { ladder, lessonTopic } = profile(level);
  const topics = TOPICS(lessonTopic);
  for (let i = 0; i < PER_LEVEL; i++) {
    const topic = topics[i % topics.length]!;
    const n = Math.floor(i / topics.length) + 1;
    const req: StoryRequest = {
      // a numbered take, so the proxy's cache does not hand back the same story
      topic: n > 1 ? `${topic} (take ${n})` : topic,
      learnerLevel: level,
      length: storyLength(level),
      rungs: storyPromptRungs({ ladder, lexicon, rng: mulberry(i + 1) }),
      budget: promptBudget(budget),
      grammar: ladder.grammar.allowed.flatMap((id) => lexicon.grammarItemById(id)?.pattern ?? []).slice(0, 80),
      grammarNext: ladder.grammar.next.flatMap((id) => lexicon.grammarItemById(id)?.pattern ?? []).slice(0, 20),
      names: ladder.properNounIds.flatMap((id) => lexicon.byId(id)?.headword ?? []).slice(0, 40),
    };
    let result: Row['result'];
    try {
      result = await runStoryPipeline({ llm, req, ladder, lexicon, difficulty: DIFFICULTY });
    } catch (err) {
      result = { ok: false, reasons: ['error'], attempts: [], error: err instanceof Error ? err.message : String(err) };
    }
    rows.push({ level, topic, n, result });
    if (result.ok) {
      const r = result.report;
      const id = `${level} · ${topic} #${n}`;
      if (r.rung1Share < budget.minRung1Share) violations.push(`${id}: rung 1 ${pct(r.rung1Share)}`);
      if (r.distinct[3].length > budget.maxRung3Words) violations.push(`${id}: rung 3 × ${r.distinct[3].length}`);
      if (r.distinct[4].length > budget.maxRung4Words) violations.push(`${id}: rung 4 × ${r.distinct[4].length}`);
      if (r.distinct[5].length > budget.maxRung5Words) violations.push(`${id}: rung 5 × ${r.distinct[5].length}`);
      if (r.taiwanness.length > 0) violations.push(`${id}: Taiwan / traditional`);
      if (result.questions.length < STORY_CONFIG.questions.min) violations.push(`${id}: questions`);
    }
    process.stdout.write(result.ok ? '.' : 'x');
  }
}
process.stdout.write('\n');

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// ---- the report --------------------------------------------------------------------------------
const lines: string[] = [];
lines.push('# Graded stories eval (Phase 24)', '');
if (dry)
  lines.push(
    '> **DRY RUN: not model output.** Written by `pnpm eval:stories --dry` with the offline stand-in',
    '> writer (one known word per comma). It proves the harness and the checks; the real eval needs',
    '> `pnpm eval:stories` against a live proxy with both API keys, then a read-through by Ezra.',
    '',
  );
lines.push(
  `Generated ${NOW.toISOString()} from ${dry ? 'the offline stand-in' : proxyUrl} · difficulty ${DIFFICULTY} · ${PER_LEVEL} stories per level on 5 topics.`,
  '',
  '| Level | Asked | Shown | Not shown | Regenerated | Rung 1 (mean) | Avg characters |',
  '|---|---|---|---|---|---|---|',
);
for (const level of ['N1', 'L1'] as Level[]) {
  const rs = rows.filter((r) => r.level === level);
  const shown = rs.flatMap((r) => (r.result.ok ? [r.result] : []));
  const regen = rs.filter((r) => r.result.attempts.length > 1).length;
  const mean = shown.length ? shown.reduce((s, x) => s + x.report.rung1Share, 0) / shown.length : 0;
  const chars = shown.length ? Math.round(shown.reduce((s, x) => s + x.report.chars, 0) / shown.length) : 0;
  lines.push(`| ${level} | ${rs.length} | ${shown.length} | ${rs.length - shown.length} | ${regen} | ${pct(mean)} | ${chars} |`);
}
lines.push('', `Hard-rule violations among shown stories: **${violations.length}**${violations.length ? ` (${violations.join('; ')})` : ''}.`, '');
for (const r of rows) {
  lines.push(`## ${r.level} · ${r.topic} #${r.n}`, '');
  if (!r.result.ok) {
    lines.push(`Not shown: ${r.result.reasons.join(', ')}${'error' in r.result ? ` (${r.result.error})` : ''}. Attempts: ${r.result.attempts.length}.`, '');
    continue;
  }
  const { story, report, questions, attempts } = r.result;
  const d = report.distinct;
  const word = (x: string) => lexicon.byId(x)?.headword ?? x;
  lines.push(
    `**${story.title_zh}** (${story.title_en}) · ${report.chars} characters · rung 1 ${pct(report.rung1Share)} · attempts ${attempts.length}`,
    '',
    `Rung 2: ${d[2].map(word).join('、') || 'none'} · rung 3: ${d[3].map(word).join('、') || 'none'} · rung 4: ${d[4].map(word).join('、') || 'none'} · rung 5: ${d[5].map(word).join('、') || 'none'} · rung 6 (glossed): ${d[6].map(word).join('、') || 'none'}`,
    '',
    ...story.paragraphs.flatMap((p) => [`> ${p.zh}`, '>', `> _${p.en}_`, '']),
    `Summary: ${story.summary_en}`,
    '',
    ...questions.map((q, i) => `${i + 1}. ${q.q_zh} (${q.q_en}): ${q.options.map((o, k) => (k === q.answer ? `**${o.zh}**` : o.zh)).join(' / ')}`),
    '',
    'Verdict (Ezra): ',
    '',
  );
}
writeFileSync(path.join(root, 'docs/stories-eval.md'), `${lines.join('\n')}\n`);
console.log(`wrote docs/stories-eval.md (${rows.filter((r) => r.result.ok).length}/${rows.length} shown${dry ? ', DRY RUN' : ''})`);
if (violations.length > 0) {
  console.error(`HARD-RULE VIOLATIONS:\n${violations.join('\n')}`);
  process.exit(1);
}
