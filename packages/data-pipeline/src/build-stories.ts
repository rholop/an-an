/**
 * Phase 26 Part E: lesson stories made ahead. Writes 3 stories per textbook lesson that pass the
 * STRICT targets (not just the mini-lesson floors) and the independent check, using only the words
 * of that lesson and the lessons before it, plus the book's TOCFL gate levels. Run on the owner's
 * machine or the server (never in the web app), against a running proxy:
 *
 *   SITE_CODE=… pnpm stories:build              # continues where the last run stopped
 *   SITE_CODE=… pnpm stories:build --status     # what is done, no model calls
 *
 * Phase 30 Part B.1: safe to rerun. Lessons that already have their stories are skipped, every
 * story is saved as soon as it passes, and existing stories are never overwritten (only `--redo`
 * replaces a lesson's, after a backup). Options:
 *   --status                   table of every lesson's story count, then exit (no model calls)
 *   --book laixue-2[,laixue-3] only these books        --lesson 4   only lesson 4 (of each book)
 *   --from laixue-2-L02        start at that lesson and continue in course order
 *   --per-lesson N             a lower target for a quick first pass (default 3)
 *   --max-calls N              stop cleanly after N model calls (free tier)
 *   --redo laixue-1-L04        replace that lesson's stories (asks first unless --yes; backs up)
 *   --delay ms                 pause between model calls (default 4000)
 *   --model gemini-…           one model instead of the proxy's chains (must be in a chain)
 *   --dry                      the offline stand-in writer; writes nothing
 * A rate limit (429/503) is waited out (retry-after) and never counts as a refused attempt; after
 * 3 in a row, or when the proxy's daily budget is spent, the run stops cleanly (exit 0).
 * Phase 33: requests are sent as `x-ai-priority: batch` (the live app keeps its reserve of each
 * model's free quota). When the proxy says the free quota is used up on every model
 * (503 quota_exhausted) the run stops at once and says when the quota resets (exit 0).
 * Output: data/curriculum/<book>/private/stories.json (served behind the household code).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLedger,
  scriptQuotaStopMessage,
  courseLessonLevel,
  DEFAULT_SESSION_SETTINGS,
  DEFAULT_STUDY_SETTINGS,
  LAIXUE_COURSE,
  LEVEL_IDS,
  lessonCoreWordIds,
  dryStory,
  dryStoryCheck,
  dryStoryRepair,
  LessonStoriesFileSchema,
  lessonsInCourseOrder,
  Lexicon,
  promptBudget,
  runStoryPipeline,
  StoryCheckResponseSchema,
  storyBudget,
  storyLength,
  storyPromptLists,
  StoryRepairResponseSchema,
  StoryResponseSchema,
  STORY_CONFIG,
  type GrammarItem,
  type Level,
  type LessonStory,
  type SkillCard,
  type StoryLLM,
  type StoryRequest,
  type Textbook,
  type VocabLadder,
  type VocabRung,
  type Word,
} from '@anan/core';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The command line (Phase 30 Part B.1). */
export interface BuildOptions {
  status: boolean;
  dry: boolean;
  books?: string[];
  lesson?: number;
  from?: string;
  perLesson: number;
  maxCalls?: number;
  redo?: string;
  yes: boolean;
  delayMs: number;
  /** Phase 33: one model instead of the chains (`x-ai-model`). */
  model?: string;
}

export function parseArgs(argv: readonly string[]): BuildOptions {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string): number | undefined => {
    const v = arg(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number, got "${v}"`);
    return n;
  };
  const dry = argv.includes('--dry');
  const books = arg('book')?.split(',').map((b) => b.trim()).filter(Boolean);
  const lesson = num('lesson');
  const from = arg('from');
  const maxCalls = num('max-calls');
  const redo = arg('redo');
  return {
    status: argv.includes('--status'),
    dry,
    ...(books?.length ? { books } : {}),
    ...(lesson !== undefined ? { lesson } : {}),
    ...(from ? { from } : {}),
    perLesson: Math.min(num('per-lesson') ?? STORY_CONFIG.lessonStories.perLesson, STORY_CONFIG.lessonStories.perLesson),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
    ...(redo ? { redo } : {}),
    yes: argv.includes('--yes'),
    delayMs: num('delay') ?? (dry ? 0 : 4000),
    ...(arg('model') ? { model: arg('model')! } : {}),
  };
}

/** Phase 29 Part B.13: a lesson's story level is the course's (`course.ts`: book 4 is L2 up to
 * lesson 5, L3 after), and its gate is every TOCFL level below it (the study focus's gate). */
export function lessonLevelAndGate(bookId: string, n: number): { level: Level; gate: Level[] } {
  const level = courseLessonLevel(LAIXUE_COURSE, bookId, n);
  return { level, gate: LEVEL_IDS.slice(0, LEVEL_IDS.indexOf(level)) };
}

const lexFile = JSON.parse(readFileSync(path.join(REPO, 'data/build/lexicon.v2.json'), 'utf8')) as { words: Word[]; grammar: GrammarItem[] };
const bookFiles = [1, 2, 3, 4].map(
  (n) =>
    JSON.parse(readFileSync(path.join(REPO, `data/curriculum/laixue-${n}/book.json`), 'utf8')) as {
      textbook: Textbook;
      grammarItems: GrammarItem[];
    },
);
const books = bookFiles.map((b) => b.textbook);
const lexicon = new Lexicon(lexFile.words, [...lexFile.grammar, ...bookFiles.flatMap((b) => b.grammarItems)]);
const NOW = new Date();

/** A rate limit from the proxy or Gemini: waited out, never a refused attempt. */
export class RateLimited extends Error {
  constructor(
    readonly retryAfterMs: number | undefined,
    /** The proxy's daily token budget for this install is spent: no point waiting. */
    readonly daily: boolean,
    /** Phase 33: the free Gemini quota is used up on every model until then (503 quota_exhausted). */
    readonly resetsAt?: Date,
  ) {
    super(resetsAt ? 'free quota used up' : daily ? 'daily budget used up' : 'rate limited');
  }
}
/** `--max-calls` reached. */
class CallLimit extends Error {}

/** `retry-after` in seconds or as an HTTP date, or the proxy's `retryAfterMs` in the body. */
export function retryAfterMs(header: string | null, body: unknown, now: number = Date.now()): number | undefined {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const ms = (body as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === 'number' && ms >= 0 ? ms : undefined;
}

export interface BuildDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Progress dots ('.', 'x', '!') without a newline. */
  tick: (c: string) => void;
  /** `--redo` confirmation. */
  confirm: (question: string) => Promise<boolean>;
  /** Where `data/curriculum` lives (the repo, or a test copy). */
  root: string;
  proxyUrl: string;
  siteCode: string;
  now: () => Date;
}

function storyLlm(opts: BuildOptions, deps: BuildDeps, counter: { calls: number }): StoryLLM {
  if (opts.dry)
    return { writeStory: async (r) => ({ story: dryStory(r) }), checkStory: async (r) => dryStoryCheck(r), repairStory: async (r) => dryStoryRepair(r) };
  let lastCall = 0;
  const post = async (route: string, body: unknown): Promise<unknown> => {
    if (opts.maxCalls !== undefined && counter.calls >= opts.maxCalls) throw new CallLimit();
    const wait = lastCall + opts.delayMs - deps.now().getTime();
    if (wait > 0) await deps.sleep(wait);
    lastCall = deps.now().getTime();
    counter.calls++;
    const res = await deps.fetch(`${deps.proxyUrl}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-install-id': 'stories-build',
        'x-site-code': deps.siteCode,
        // Phase 33: a script: leave each model's reserve to the live app
        'x-ai-priority': 'batch',
        ...(opts.model ? { 'x-ai-model': opts.model } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      const data = (await res.json().catch(() => null)) as { error?: unknown; resetsAt?: unknown } | null;
      if (data?.error === 'quota_exhausted' && typeof data.resetsAt === 'string' && !Number.isNaN(Date.parse(data.resetsAt))) {
        counter.calls--; // no model was called
        throw new RateLimited(undefined, true, new Date(data.resetsAt));
      }
      const daily = res.status === 429 && /daily/i.test(String(data?.error ?? ''));
      throw new RateLimited(retryAfterMs(res.headers.get('retry-after'), data, deps.now().getTime()), daily);
    }
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
    return res.json();
  };
  return {
    writeStory: async (r) => ({ story: StoryResponseSchema.parse(await post('/v1/story', r)) }),
    checkStory: async (r) => StoryCheckResponseSchema.parse(await post('/v1/story-check', r)),
    repairStory: async (r) => StoryRepairResponseSchema.parse(await post('/v1/story-repair', r)),
  };
}

/** The fixture profile's cards: every known word Learned long ago (recognition and production). */
const mature = (id: string, skill: 'recognition' | 'production' = 'recognition'): SkillCard => ({
  item: { kind: 'word', id },
  skill,
  card: {
    due: new Date(NOW.getTime() + 30 * 86_400_000),
    stability: 60,
    difficulty: 5,
    elapsed_days: 10,
    scheduled_days: 60,
    learning_steps: 0,
    reps: 6,
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
 * The ladder for one lesson, built by the ledger from a fixture profile that knows every earlier
 * lesson's core words and the gate levels (Phase 29 Part B.13): rung 1 = what that profile can read,
 * rung 2 = this lesson's core words (grammar words in, names out), nothing on rungs 3–5 (every other
 * word is outside the lists).
 */
export function lessonStoryLadder(bookId: string, lessonId: string): { ladder: VocabLadder; level: Level } {
  const ordered = lessonsInCourseOrder(books);
  const at = ordered.findIndex((o) => o.lesson.id === lessonId);
  const lesson = ordered[at]!.lesson;
  const { level, gate } = lessonLevelAndGate(bookId, lesson.n);
  const before = ordered.slice(0, at).flatMap((o) => lessonCoreWordIds(o.lesson));
  const gateWords = lexicon
    .allWords()
    .filter((w) => w.source === 'tocfl' && w.level && gate.includes(w.level) && !w.tags.includes('name'))
    .map((w) => w.id);
  const knownIds = [...new Set([...before, ...gateWords])];
  const ledger = buildLedger({
    cards: knownIds.flatMap((id) => [mature(id), mature(id, 'production')]),
    evidence: [],
    knownItems: [],
    session: DEFAULT_SESSION_SETTINGS,
    masteryShare: DEFAULT_STUDY_SETTINGS.masteryShare,
    now: NOW,
    study: {
      lexicon,
      books,
      settings: { ...DEFAULT_STUDY_SETTINGS },
      myClass: { enabled: true, textbookId: bookId, currentLesson: lesson.n },
      level,
    },
  });
  const base = ledger.ladder(level);
  const known = new Set(base.ids[1]);
  const r2 = new Set(lessonCoreWordIds(lesson).filter((id) => !known.has(id)));
  const empty = new Set<string>();
  const ladder: VocabLadder = {
    ...base,
    ids: { ...base.ids, 1: known, 2: r2, 3: empty, 4: empty, 5: empty },
    rung: (id: string): VocabRung => (known.has(id) ? 1 : r2.has(id) ? 2 : 6),
  };
  return { ladder, level };
}

const storiesFile = (root: string, bookId: string) => path.join(root, 'data/curriculum', bookId, 'private', 'stories.json');

function load(file: string): LessonStory[] {
  if (!existsSync(file)) return [];
  const parsed = LessonStoriesFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (parsed.success) return parsed.data.stories;
  // Never drop or rewrite saved stories on a schema mismatch: say which ones and stop.
  const where = [...new Set(parsed.error.issues.map((i) => `${i.path.slice(0, 2).join(' ')}: ${i.path.slice(2).join('.')} ${i.message}`))];
  throw new Error(`${file} does not match the stories format (nothing was changed):\n  ${where.slice(0, 10).join('\n  ')}`);
}

function save(file: string, stories: readonly LessonStory[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, stories }, null, 1)}\n`);
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

export interface BuildResult {
  written: number;
  failed: number;
  calls: number;
  /** Why the run stopped early, if it did. */
  stopped?: 'quota' | 'daily' | 'max-calls';
  /** Phase 33: when the free quota resets (the proxy's quota_exhausted). */
  resetsAt?: Date;
  /** The lesson a rerun continues from. */
  resumeAt?: string;
  /** Lessons in scope still short of the full 3. */
  short: string[];
}

/** Lessons in course order, narrowed by --book, --lesson, --from and --redo. */
function lessonsInScope(opts: BuildOptions): Array<{ lesson: Textbook['lessons'][number]; bookId: string }> {
  let list = lessonsInCourseOrder(books);
  if (opts.redo) return list.filter((o) => o.lesson.id === opts.redo);
  if (opts.books) list = list.filter((o) => opts.books!.includes(o.bookId));
  if (opts.lesson !== undefined) list = list.filter((o) => o.lesson.n === opts.lesson);
  if (opts.from) {
    const at = list.findIndex((o) => o.lesson.id === opts.from);
    if (at < 0) throw new Error(`--from ${opts.from}: no such lesson in scope`);
    list = list.slice(at);
  }
  return list;
}

/** `--status`: every lesson of every book with its story count. No model calls. */
export function statusTable(root: string): string[] {
  const full = STORY_CONFIG.lessonStories.perLesson;
  const lines: string[] = [];
  for (const book of books) {
    const stories = load(storiesFile(root, book.id));
    const done = book.lessons.filter((l) => stories.filter((s) => s.lessonId === l.id).length >= full).length;
    lines.push(`${book.id}: ${done} of ${book.lessons.length} lessons have ${full} stories`);
    for (const l of book.lessons) lines.push(`  ${l.id} ${stories.filter((s) => s.lessonId === l.id).length}/${full}`);
  }
  return lines;
}

export async function buildStories(opts: BuildOptions, deps: BuildDeps): Promise<BuildResult> {
  const full = STORY_CONFIG.lessonStories.perLesson;
  const result: BuildResult = { written: 0, failed: 0, calls: 0, short: [] };
  if (opts.status) {
    for (const line of statusTable(deps.root)) deps.log(line);
    return result;
  }
  const scope = lessonsInScope(opts);
  if (opts.redo && scope.length === 0) throw new Error(`--redo ${opts.redo}: no such lesson`);
  const files = new Map<string, LessonStory[]>();
  const storiesOf = (bookId: string) => {
    if (!files.has(bookId)) files.set(bookId, load(storiesFile(deps.root, bookId)));
    return files.get(bookId)!;
  };

  if (opts.redo) {
    const { bookId } = scope[0]!;
    const file = storiesFile(deps.root, bookId);
    const old = storiesOf(bookId).filter((s) => s.lessonId === opts.redo).length;
    if (!opts.yes && !(await deps.confirm(`Replace the ${old} stories of ${opts.redo}? A backup is kept. [y/N] `))) {
      deps.log('Nothing changed.');
      return result;
    }
    if (existsSync(file) && !opts.dry) {
      const backup = file.replace(/stories\.json$/, `stories.${stamp(deps.now())}.bak.json`);
      copyFileSync(file, backup);
      deps.log(`Backed up to ${path.relative(deps.root, backup)}`);
    }
    files.set(bookId, storiesOf(bookId).filter((s) => s.lessonId !== opts.redo));
  } else {
    const done = scope.filter((o) => storiesOf(o.bookId).filter((s) => s.lessonId === o.lesson.id).length >= opts.perLesson).length;
    deps.log(
      `Resuming: ${done} of ${scope.length} lessons already have ${opts.perLesson} ${opts.perLesson === 1 ? 'story' : 'stories'} and will be skipped. Existing stories are never overwritten.`,
    );
  }

  const counter = { calls: 0 };
  const llm = storyLlm(opts, deps, counter);
  const target = opts.redo ? full : opts.perLesson;
  let limitedInARow = 0;

  for (const [i, { lesson, bookId }] of scope.entries()) {
    const stories = storiesOf(bookId);
    const have = stories.filter((s) => s.lessonId === lesson.id);
    if (have.length >= target) continue;
    const { ladder, level } = lessonStoryLadder(bookId, lesson.id);
    const topics = [`${lesson.titleEn}: ${lesson.topic}`, ...lesson.objectives.slice(0, 2).map((o) => `${lesson.topic}: ${o}`)];
    const names = ladder.properNounIds.flatMap((id) => lexicon.byId(id)?.headword ?? []).slice(0, 40);
    const used = new Set(have.map((s) => s.id));
    let k = have.length;
    let attempt = 0;
    while (k < target && attempt < target * STORY_CONFIG.lessonStories.maxAttemptsPerStory) {
      const topic = topics[(k + attempt) % topics.length]!;
      const lists = storyPromptLists({ ladder, lexicon, topic, rng: () => 0.5 });
      const req: StoryRequest = {
        topic,
        learnerLevel: level,
        length: storyLength(level),
        rungs: lists.rungs,
        groups: lists.groups,
        budget: promptBudget(storyBudget('middle')),
        grammar: ladder.grammar.allowed.flatMap((id) => lexicon.grammarItemById(id)?.pattern ?? []).slice(0, 80),
        grammarNext: [],
        names,
        // every attempt is its own variant, so the proxy cache never returns an earlier story
        variant: attempt + 1,
      };
      try {
        const out = await runStoryPipeline({ llm, req, ladder, lexicon, difficulty: 'middle' });
        limitedInARow = 0;
        attempt++;
        // Strict targets only: a mini lesson is fine live, not for a story made ahead.
        if (!out.ok || out.miniLesson) {
          result.failed++;
          deps.tick('x');
          continue;
        }
        k++;
        result.written++;
        let n = k;
        while (used.has(`${lesson.id}-s${n}`)) n++;
        used.add(`${lesson.id}-s${n}`);
        stories.push({ id: `${lesson.id}-s${n}`, bookId, lessonId: lesson.id, level, topic, story: out.story });
        if (!opts.dry) save(storiesFile(deps.root, bookId), stories);
        deps.tick('.');
      } catch (err) {
        const stop = (why: BuildResult['stopped']) => {
          result.stopped = why;
          result.resumeAt = lesson.id;
          deps.log(` ${lesson.id}: ${k}/${full}`);
        };
        if (err instanceof CallLimit) {
          stop('max-calls');
          break;
        }
        if (err instanceof RateLimited) {
          limitedInARow++;
          if (err.resetsAt) {
            result.resetsAt = err.resetsAt;
            stop('quota');
            break;
          }
          if (err.daily) {
            stop('daily');
            break;
          }
          if (limitedInARow >= 3) {
            stop('quota');
            break;
          }
          // waited out; this attempt doesn't count
          deps.tick('~');
          await deps.sleep(err.retryAfterMs ?? 60_000);
          continue;
        }
        attempt++;
        result.failed++;
        deps.tick('!');
        deps.log(`\n${lesson.id}: ${(err as Error).message}`);
      }
    }
    if (result.stopped) {
      result.short.push(...scope.slice(i).filter((o) => storiesOf(o.bookId).filter((s) => s.lessonId === o.lesson.id).length < full).map((o) => o.lesson.id));
      break;
    }
    deps.log(` ${lesson.id}: ${k}/${full}`);
  }
  result.calls = counter.calls;
  if (!result.stopped)
    result.short = scope.filter((o) => storiesOf(o.bookId).filter((s) => s.lessonId === o.lesson.id).length < full).map((o) => o.lesson.id);
  const total = [...files.values()].reduce((n, list) => n + list.length, 0);
  if (result.resetsAt) {
    const doneInScope = scope.reduce((n, o) => n + Math.min(target, storiesOf(o.bookId).filter((st) => st.lessonId === o.lesson.id).length), 0);
    deps.log(
      `${scriptQuotaStopMessage({ verb: 'Wrote', done: doneInScope, total: scope.length * target, unit: 'stories', resetsAt: result.resetsAt, now: deps.now() })} It continues from ${result.resumeAt}.`,
    );
  } else if (result.stopped === 'quota' || result.stopped === 'daily')
    deps.log(
      `${result.stopped === 'daily' ? "The proxy's daily budget for this build is used up (DAILY_TOKEN_BUDGET)" : 'Free quota used up for now'}. Saved so far: ${total} stories. Run the same command later to continue from ${result.resumeAt}.`,
    );
  if (result.stopped === 'max-calls')
    deps.log(`Stopped after ${result.calls} model calls (--max-calls). Saved so far: ${total} stories. Run again to continue from ${result.resumeAt}.`);
  deps.log(`${result.written} stories written, ${result.failed} attempts refused${opts.dry ? ' (DRY RUN: nothing saved)' : ''}.`);
  if (result.short.length > 0) deps.log(`Still short of ${full}: ${result.short.join(', ')}`);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await buildStories(opts, {
    fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    tick: (c) => process.stdout.write(c),
    confirm: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(q);
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    },
    root: REPO,
    proxyUrl: process.env.PROXY_URL ?? 'http://localhost:3002',
    siteCode: process.env.SITE_CODE ?? '',
    now: () => new Date(),
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  await main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
