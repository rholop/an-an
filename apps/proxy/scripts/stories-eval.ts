/**
 * Phase 24/26 acceptance: 20 graded stories per level (N1, N2, L1) written, repaired and checked
 * through the REAL pipeline (`runStoryPipeline`: write → code checks → sentence repair → independent
 * check on the checker model) against a LIVE proxy. Writes docs/stories-eval.md with, per attempt,
 * the known-or-this-lesson share before and after repair, the mini-lesson words and the reason when
 * a story is refused.
 *
 *   pnpm --filter @anan/proxy dev   # one terminal (needs GEMINI_API_KEY)
 *   pnpm eval:stories [--profile anan-ron-2026-10-09.json]   # another
 *
 * `--profile` uses a real profile export (Settings → Export): its cards decide known / due words.
 * Env: PROXY_URL (default http://localhost:3002), SITE_CODE (the household code), CLASS (e.g.
 * "laixue-1:4", the My class book and lesson; default book 1 lesson 4 for N1/N2, book 2 lesson 3 for L1).
 * `--dry` runs the same harness with the offline stand-in writer (no keys needed) and marks the doc
 * as a DRY RUN: it proves the harness, it is not model output.
 * Exits 1 if a shown story breaks a hard rule (below the floor, an unexplained word, Taiwan usage),
 * or (live runs) fewer than 18 of 20 per level are shown.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STUDY_SETTINGS,
  dryStory,
  dryStoryCheck,
  dryStoryRepair,
  miniLessonWordCount,
  storyPromptLists,
  StoryRepairResponseSchema,
  getStudyFocus,
  Lexicon,
  promptBudget,
  ProviderNameSchema,
  STORY_CONFIG,
  storyBudget,
  storyLength,
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
const profileArg = process.argv.indexOf('--profile');
const profileFile = profileArg > 0 ? process.argv[profileArg + 1] : undefined;
const LEVELS: Level[] = ['N1', 'N2', 'L1'];
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

/** Cards from a real profile export (Settings → Export), when `--profile` is given. */
function exportedCards(): SkillCard[] | undefined {
  if (!profileFile) return undefined;
  const raw = JSON.parse(readFileSync(profileFile, 'utf8')) as { items?: Array<SkillCard & { card: { due: string | Date; last_review?: string | Date } }> };
  return (raw.items ?? []).map((c) => ({
    ...c,
    card: { ...c.card, due: new Date(c.card.due), ...(c.card.last_review ? { last_review: new Date(c.card.last_review) } : {}) },
  })) as SkillCard[];
}

/**
 * The learner: a real export when given, else a seeded one. Seeded Novice (N1/N2): class = 來學華語 1
 * Lesson 4, lessons 1–3 and the 150 most frequent N1 words learned, 220 of them due (the owner's case).
 * Seeded L1: N1 and N2 Mastered, book 1 learned, class = 來學華語 2 Lesson 3.
 */
function profile(level: Level) {
  const byFreq = (lv: Level) =>
    lexicon
      .allWords()
      .filter((w) => w.level === lv && w.source === 'tocfl')
      .sort((a, b) => (a.freqRank ?? 1e9) - (b.freqRank ?? 1e9));
  const novice = level === 'N1' || level === 'N2';
  const [classBook, classLesson] = (process.env.CLASS ?? (novice ? 'laixue-1:4' : 'laixue-2:3')).split(':');
  const real = exportedCards();
  let cards: SkillCard[];
  let known: string[];
  let due: string[] = [];
  if (real) {
    cards = real;
    const rec = real.filter((c) => c.item.kind === 'word' && c.skill === 'recognition' && c.state !== 'unseen' && c.state !== 'introduced');
    known = rec.map((c) => c.item.id);
    due = rec.filter((c) => c.card.due.getTime() <= NOW.getTime()).map((c) => c.item.id);
  } else {
    known = novice
      ? [...byFreq('N1').slice(0, 150).map((w) => w.id), ...books[0]!.lessons.slice(0, 3).flatMap((l) => l.vocab)]
      : [...byFreq('N1').map((w) => w.id), ...byFreq('N2').map((w) => w.id), ...books[0]!.lessons.flatMap((l) => l.vocab)];
    known = [...new Set(known)];
    if (novice) due = known.slice(0, 220);
    cards = known.flatMap((id) => [card(id, 'recognition'), card(id, 'production')]);
  }
  const focus = getStudyFocus(
    {
      lexicon,
      books,
      cards,
      grammarUses: new Map(),
      settings: { ...DEFAULT_STUDY_SETTINGS },
      myClass: { enabled: true, textbookId: classBook!, currentLesson: Number(classLesson) },
    },
    NOW,
  );
  const ladder = vocabLadder({
    lexicon,
    level,
    knownIds: new Set(known),
    dueIds: new Set(due),
    learningIds: new Set(),
    books,
    studyFocus: focus,
  });
  const active = ladder.lessons.active;
  return { ladder, due: new Set(due), lessonTopic: active ? `${active.titleEn}: ${active.topic}` : 'everyday life' };
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
      repairStory: async (req) => dryStoryRepair(req),
    }
  : {
      writeStory: async (req) => {
        const { json, servedBy } = await post('/v1/story', req);
        return { story: StoryResponseSchema.parse(json), ...(servedBy ? { servedBy } : {}) };
      },
      checkStory: async (req) => StoryCheckResponseSchema.parse((await post('/v1/story-check', req)).json),
      repairStory: async (req) => StoryRepairResponseSchema.parse((await post('/v1/story-repair', req)).json),
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
for (const level of LEVELS) {
  const { ladder, lessonTopic, due } = profile(level);
  const topics = TOPICS(lessonTopic);
  for (let i = 0; i < PER_LEVEL; i++) {
    const topic = topics[i % topics.length]!;
    const n = Math.floor(i / topics.length) + 1;
    const lists = storyPromptLists({ ladder, lexicon, dueIds: due, rng: mulberry(i + 1), topic });
    const req: StoryRequest = {
      topic,
      learnerLevel: level,
      length: storyLength(level),
      rungs: lists.rungs,
      groups: lists.groups,
      // Phase 26: every attempt is its own variant, so the proxy's cache never hands back a story
      variant: n,
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
      // Phase 26 Part D: the floors and "never unexplained" are the hard rules for a shown story.
      const r = result.report;
      const id = `${level} · ${topic} #${n}`;
      const glossed = new Set(result.story.glosses.map((g) => g.zh));
      if (r.knownShare < STORY_CONFIG.miniLesson.floor[DIFFICULTY]) violations.push(`${id}: known ${pct(r.knownShare)}`);
      if (miniLessonWordCount(r) > STORY_CONFIG.miniLesson.maxWords[DIFFICULTY]) violations.push(`${id}: ${miniLessonWordCount(r)} new words`);
      const unexplained = r.paragraphs.flat().filter((t) => t.rung !== 'allowed' && t.rung >= 3 && !glossed.has(t.text));
      if (unexplained.length) violations.push(`${id}: unexplained ${unexplained.map((t) => t.text).join('、')}`);
      if (r.taiwanness.length > 0) violations.push(`${id}: Taiwan / traditional`);
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
lines.push('# Graded stories eval (Phase 24, Phase 26)', '');
if (dry)
  lines.push(
    '> **DRY RUN: not model output.** Written by `pnpm eval:stories --dry` with the offline stand-in',
    '> writer (one known word per comma). It proves the harness and the checks; the real eval needs',
    '> `pnpm eval:stories --profile <export>` against a live proxy with the Gemini key.',
    '',
  );
lines.push(
  `Generated ${NOW.toISOString()} from ${dry ? 'the offline stand-in' : proxyUrl} · ${profileFile ? `profile ${path.basename(profileFile)}` : 'seeded learners'} · difficulty ${DIFFICULTY} · ${PER_LEVEL} stories per level on 5 topics.`,
  '',
  '| Level | Asked | Shown | Mini lessons | Not shown | Repaired | Known share (mean) | Avg characters |',
  '|---|---|---|---|---|---|---|---|',
);
const short: string[] = [];
for (const level of LEVELS) {
  const rs = rows.filter((r) => r.level === level);
  const shown = rs.flatMap((r) => (r.result.ok ? [r.result] : []));
  const mini = shown.filter((x) => x.miniLesson).length;
  const repaired = rs.filter((r) => r.result.attempts.some((a) => a.via === 'repair')).length;
  const mean = shown.length ? shown.reduce((s, x) => s + x.report.knownShare, 0) / shown.length : 0;
  const chars = shown.length ? Math.round(shown.reduce((s, x) => s + x.report.chars, 0) / shown.length) : 0;
  lines.push(`| ${level} | ${rs.length} | ${shown.length} | ${mini} | ${rs.length - shown.length} | ${repaired} | ${pct(mean)} | ${chars} |`);
  if (shown.length < Math.ceil(PER_LEVEL * 0.9)) short.push(`${level}: ${shown.length}/${rs.length} shown`);
}
lines.push('', `Hard-rule violations among shown stories: **${violations.length}**${violations.length ? ` (${violations.join('; ')})` : ''}.`, '');
const word = (x: string) => lexicon.byId(x)?.headword ?? x;
for (const r of rows) {
  lines.push(`## ${r.level} · ${r.topic} #${r.n}`, '');
  lines.push(
    ...r.result.attempts.map(
      (a, k) =>
        `- Attempt ${k + 1} (${a.via ?? 'write'}): known or this lesson ${pct(a.report.knownShare)}, rung 1 ${pct(a.report.rung1Share)}, ${a.report.chars} characters${a.report.failed.length ? `, missed: ${a.report.failed.join(', ')}` : ', met every target'}`,
    ),
    '',
  );
  if (!r.result.ok) {
    lines.push(`**Not shown:** ${r.result.reasons.join(', ')}${'error' in r.result ? ` (${r.result.error})` : ''}.`, '');
    continue;
  }
  const { story, report, questions } = r.result;
  const d = report.distinct;
  lines.push(
    `**${story.title_zh}** (${story.title_en}) · ${report.chars} characters · known or this lesson ${pct(report.knownShare)}${r.result.miniLesson ? ' · **mini lesson**' : ''}`,
    '',
    `This lesson: ${d[2].map(word).join('、') || 'none'} · words taught first: ${story.glosses.map((g) => `${g.zh} (${g.en})`).join('、') || 'none'}`,
    '',
    ...story.paragraphs.flatMap((p) => [`> ${p.zh}`, '>', `> _${p.en}_`, '']),
    `Summary: ${story.summary_en}`,
    '',
    ...(questions.length
      ? questions.map((q, i) => `${i + 1}. ${q.q_zh} (${q.q_en}): ${q.options.map((o, k) => (k === q.answer ? `**${o.zh}**` : o.zh)).join(' / ')}`)
      : ['No questions for this one.']),
    '',
  );
}
writeFileSync(path.join(root, 'docs/stories-eval.md'), `${lines.join('\n')}\n`);
console.log(`wrote docs/stories-eval.md (${rows.filter((r) => r.result.ok).length}/${rows.length} shown${dry ? ', DRY RUN' : ''})`);
if (violations.length > 0) {
  console.error(`HARD-RULE VIOLATIONS:\n${violations.join('\n')}`);
  process.exit(1);
}
if (!dry && short.length > 0) {
  console.error(`Fewer than 18 of 20 shown: ${short.join('; ')}`);
  process.exit(1);
}
