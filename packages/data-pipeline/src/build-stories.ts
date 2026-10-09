/**
 * Phase 26 Part E: lesson stories made ahead. Writes 3 stories per textbook lesson that pass the
 * STRICT targets (not just the mini-lesson floors) and the independent check, using only the words
 * of that lesson and the lessons before it, plus the book's TOCFL gate levels. Run on the owner's
 * machine or the server (never in the web app), against a running proxy:
 *
 *   pnpm --filter @anan/proxy dev                 # or the live proxy (PROXY_URL)
 *   SITE_CODE=… pnpm stories:build [--book laixue-1] [--lesson 4] [--delay 4000]
 *
 * Output: data/curriculum/<book>/private/stories.json (served behind the household code with the
 * other lesson data). Resumable: lessons that already have 3 stories are skipped, and every story
 * is saved as soon as it passes. Each story gets at most `lessonStories.maxAttemptsPerStory` tries,
 * one at a time with a pause between model calls (free tier).
 * `--dry` runs the harness with the offline stand-in writer and writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STUDY_SETTINGS,
  dryStory,
  dryStoryCheck,
  dryStoryRepair,
  getStudyFocus,
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
  vocabLadder,
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
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dry = process.argv.includes('--dry');
const onlyBook = arg('book');
const onlyLesson = arg('lesson') ? Number(arg('lesson')) : undefined;
const delayMs = Number(arg('delay') ?? (dry ? 0 : 4000));
const proxyUrl = process.env.PROXY_URL ?? 'http://localhost:3002';

/** The book's story level and the TOCFL levels a learner has mastered before it (the gate). */
const BOOK_LEVEL: Record<number, { level: Level; gate: Level[] }> = {
  1: { level: 'N1', gate: [] },
  2: { level: 'L1', gate: ['N1', 'N2'] },
  3: { level: 'L2', gate: ['N1', 'N2', 'L1'] },
  4: { level: 'L2', gate: ['N1', 'N2', 'L1', 'L2'] },
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCall + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

async function post(route: string, body: unknown): Promise<unknown> {
  return paced(async () => {
    const res = await fetch(`${proxyUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-install-id': 'stories-build', 'x-site-code': process.env.SITE_CODE ?? '' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
    return res.json();
  });
}

const llm: StoryLLM = dry
  ? { writeStory: async (r) => ({ story: dryStory(r) }), checkStory: async (r) => dryStoryCheck(r), repairStory: async (r) => dryStoryRepair(r) }
  : {
      writeStory: async (r) => ({ story: StoryResponseSchema.parse(await post('/v1/story', r)) }),
      checkStory: async (r) => StoryCheckResponseSchema.parse(await post('/v1/story-check', r)),
      repairStory: async (r) => StoryRepairResponseSchema.parse(await post('/v1/story-repair', r)),
    };

const mature = (id: string): SkillCard => ({
  item: { kind: 'word', id },
  skill: 'recognition',
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
 * The ladder for one lesson: rung 1 = every earlier lesson's words and the gate levels, rung 2 = this
 * lesson's words, nothing on rungs 3–5 (every other word is outside the lists).
 */
export function lessonStoryLadder(bookN: number, lessonId: string): { ladder: VocabLadder; level: Level } {
  const { level, gate } = BOOK_LEVEL[bookN]!;
  const ordered = lessonsInCourseOrder(books);
  const at = ordered.findIndex((o) => o.lesson.id === lessonId);
  const before = ordered.slice(0, at).flatMap((o) => o.lesson.vocab);
  const gateWords = lexicon
    .allWords()
    .filter((w) => w.source === 'tocfl' && w.level && gate.includes(w.level))
    .map((w) => w.id);
  const known = new Set([...before, ...gateWords]);
  const lesson = ordered[at]!.lesson;
  const focus = getStudyFocus(
    {
      lexicon,
      books,
      cards: [...known].map(mature),
      grammarUses: new Map(),
      settings: { ...DEFAULT_STUDY_SETTINGS },
      myClass: { enabled: true, textbookId: `laixue-${bookN}`, currentLesson: lesson.n },
    },
    NOW,
  );
  const base = vocabLadder({ lexicon, level, knownIds: known, dueIds: new Set(), learningIds: new Set(), books, studyFocus: focus });
  const r2 = new Set(lesson.vocab.filter((id) => !known.has(id)));
  const empty = new Set<string>();
  const ladder: VocabLadder = {
    ...base,
    ids: { ...base.ids, 1: known, 2: r2, 3: empty, 4: empty, 5: empty },
    rung: (id: string): VocabRung => (known.has(id) ? 1 : r2.has(id) ? 2 : 6),
  };
  return { ladder, level };
}

function load(file: string): LessonStory[] {
  if (!existsSync(file)) return [];
  return LessonStoriesFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).stories;
}

async function main() {
  const per = STORY_CONFIG.lessonStories.perLesson;
  let written = 0;
  let failed = 0;
  for (const [i, book] of books.entries()) {
    if (onlyBook && book.id !== onlyBook) continue;
    const file = path.join(REPO, 'data/curriculum', book.id, 'private', 'stories.json');
    const stories = load(file);
    for (const lesson of book.lessons) {
      if (onlyLesson && lesson.n !== onlyLesson) continue;
      const have = stories.filter((s) => s.lessonId === lesson.id);
      if (have.length >= per) continue;
      const { ladder, level } = lessonStoryLadder(i + 1, lesson.id);
      const topics = [`${lesson.titleEn}: ${lesson.topic}`, ...lesson.objectives.slice(0, 2).map((o) => `${lesson.topic}: ${o}`)];
      const names = ladder.properNounIds.flatMap((id) => lexicon.byId(id)?.headword ?? []).slice(0, 40);
      let k = have.length;
      for (let attempt = 0; k < per && attempt < per * STORY_CONFIG.lessonStories.maxAttemptsPerStory; attempt++) {
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
          // Strict targets only: a mini lesson is fine live, not for a story made ahead.
          if (!out.ok || out.miniLesson) {
            failed++;
            process.stdout.write('x');
            continue;
          }
          k++;
          written++;
          stories.push({ id: `${lesson.id}-s${k}`, bookId: book.id, lessonId: lesson.id, level, topic, story: out.story });
          if (!dry) {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `${JSON.stringify({ version: 1, stories }, null, 1)}\n`);
          }
          process.stdout.write('.');
        } catch (err) {
          failed++;
          process.stdout.write('!');
          console.error(`\n${lesson.id}: ${(err as Error).message}`);
        }
      }
      console.log(` ${lesson.id}: ${k}/${per}`);
    }
  }
  console.log(`${written} stories written, ${failed} attempts refused${dry ? ' (DRY RUN: nothing saved)' : ''}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
