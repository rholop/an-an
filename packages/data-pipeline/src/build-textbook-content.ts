#!/usr/bin/env tsx
/**
 * Textbook content build (Phase 12, generalised in Phase 13).
 *
 *   pnpm curriculum:content <bookId | all>
 *
 * Validates the authored per-lesson content
 * (data/curriculum/<bookId>/content/LNN.yaml — sentences, chat scenarios,
 * journal prompts) against the course-scoped vocabulary with `analyzeText` +
 * `checkTaiwanness`, then writes
 *   - data/scenarios/<bookId>-LNN-*.yaml        (compiled by build:scenarios)
 *   - data/build/sentences.textbook-<bookId>.json
 *   - scenario ids / journal prompts into data/curriculum/<bookId>/book.json
 *
 * Books 2–4 are built from data/curriculum/<bookId>/lesson-plan.md: the run
 * REFUSES if the plan is missing, and each lesson's scenarios, NPCs and
 * journal prompts must match what the (possibly edited) plan says.
 * The content was written by hand (no LLM key is configured for the pipeline);
 * the validator is the same one LLM output must pass. Anything that fails is
 * reported and the build exits non-zero.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  courseLessonLevel,
  courseOrdinal,
  LAIXUE_COURSE,
  lessonScopedWordIds,
  lessonTag,
  Lexicon,
  ScenarioSchema,
  segment,
  textbookTag,
  type GrammarItem,
  type JournalPrompt,
  type SentenceBankEntry,
  type Textbook,
  type TextbookFile,
  type Word,
} from '@anan/core';
import { loadBookGrammar } from './lib/curriculum/grammar-source.js';
import { loadPlan, planFileHint, type PlanLesson } from './lib/curriculum/lesson-plan.js';
import { makeScopeChecker } from './lib/curriculum/scope-check.js';
import { configuredBooks, loadBookConfig } from './curriculum-import.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MIN_SENTENCES = 20;
const MIN_PROMPTS = 3;
/** Higher books ask for more: scenarios get longer, prompts ask for a paragraph using 2 grammar points. */
const MIN_GOAL_STEPS: Record<string, number> = { 'laixue-1': 1, 'laixue-2': 4, 'laixue-3': 5, 'laixue-4': 6 };
const MIN_PROMPT_GRAMMAR: Record<string, number> = { 'laixue-1': 1, 'laixue-2': 1, 'laixue-3': 2, 'laixue-4': 2 };

const ContentSchema = z.object({
  lesson: z.number().int().min(1).max(10),
  sentences: z.array(
    z.object({
      zh: z.string(),
      en: z.string(),
      grammar: z.array(z.string()).min(1),
      /** Phase 25: other word orders just as right (time / place words), for reorder grading. */
      altOrders: z.array(z.string()).optional(),
      /** Phase 25: the sentence with a typical error for its point ("Which sentence is right?"). */
      wrong: z.string().optional(),
      /** Phase 25: the reorder tiles when the automatic split is wrong (joined they are `zh`). */
      tiles: z.array(z.string()).optional(),
    }),
  ),
  scenarios: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      npc: z.object({
        id: z.string(),
        name: z.string(),
        personality: z.string(),
        speechStyle: z.string(),
        particles: z.array(z.string()).default([]),
      }),
      setting: z.string(),
      goalSteps: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            keywordHints: z.array(z.string()).default([]),
          }),
        )
        .min(1),
      vocabExtras: z.array(z.string()).default([]),
      opener: z.object({ zh: z.string(), en: z.string() }),
      successLine: z.object({ zh: z.string(), en: z.string() }),
    }),
  ),
  journalPrompts: z.array(
    z.object({
      en: z.string(),
      zh: z.string().optional(),
      words: z.array(z.string()).min(3),
      grammar: z.array(z.string()).min(1),
    }),
  ),
});
type Content = z.infer<typeof ContentSchema>;

interface BookShape extends TextbookFile {
  grammarItems: GrammarItem[];
  wordNotes: Array<{ wordId: string; headword: string; lesson: number }>;
}

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

function loadLexicon(): Lexicon {
  const lexRaw = JSON.parse(
    readFileSync(path.join(REPO, 'data/build/lexicon.v2.json'), 'utf8'),
  ) as { words: Word[]; grammar: GrammarItem[] };
  return new Lexicon(lexRaw.words, lexRaw.grammar);
}

function buildBook(bookId: string, lexicon: Lexicon, allBooks: Map<string, BookShape>): void {
  const DIR = path.join(REPO, 'data/curriculum', bookId);
  const CONTENT_DIR = path.join(DIR, 'content');
  const BOOK_FILE = path.join(DIR, 'book.json');
  const cfg = loadBookConfig(bookId);
  const book = allBooks.get(bookId)!;
  const courseBooks: Textbook[] = [...allBooks.values()]
    .filter((b) => (courseOrdinal(LAIXUE_COURSE, b.textbook.id, 1) ?? 99) <= (courseOrdinal(LAIXUE_COURSE, bookId, 1) ?? 0))
    .map((b) => b.textbook);
  const bookNo = LAIXUE_COURSE.books.findIndex((b) => b.id === bookId) + 1;
  const idPrefix = bookNo === 1 ? 'tb' : `tb-b${bookNo}`;

  // ---- the lesson plan gates generation for books 2–4
  let plan: PlanLesson[] | undefined;
  if (bookId !== 'laixue-1') plan = loadPlan(DIR, bookId);

  // Grammar tables of this and earlier books (a lesson may exercise earlier points).
  const grammarById = new Map<string, { lesson: number; matcher: string; bookId: string }>();
  for (const id of configuredBooks()) {
    if ((courseOrdinal(LAIXUE_COURSE, id, 1) ?? 99) > (courseOrdinal(LAIXUE_COURSE, bookId, 1) ?? 0)) continue;
    const c = loadBookConfig(id);
    for (const g of loadBookGrammar(c.grammarSource, path.join(REPO, 'data/curriculum', id)))
      if (!grammarById.has(g.id)) grammarById.set(g.id, { lesson: g.lesson, matcher: g.matcher, bookId: id });
  }
  // A re-teach point is exercised in the lesson of THIS book that lists it.
  const ownGrammar = loadBookGrammar(cfg.grammarSource, DIR);
  const matcherOf = (id: string) => new RegExp(grammarById.get(id)!.matcher, 'u');

  const files = existsSync(CONTENT_DIR)
    ? readdirSync(CONTENT_DIR)
        .filter((f) => /^L\d\d\.yaml$/.test(f))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`No content in ${CONTENT_DIR}`);
  if (files.length !== book.textbook.lessons.length)
    fail(`${bookId}: ${files.length} content files for ${book.textbook.lessons.length} lessons`);

  const allSentences: SentenceBankEntry[] = [];
  const stats: string[] = [];

  for (const file of files) {
    const content: Content = ContentSchema.parse(
      yaml.load(readFileSync(path.join(CONTENT_DIR, file), 'utf8')),
    );
    const n = content.lesson;
    const lesson = book.textbook.lessons[n - 1]!;
    const level = courseLessonLevel(LAIXUE_COURSE, bookId, n);
    const L = `${bookId} L${n}`;
    const scope = makeScopeChecker(lexicon, courseBooks, n, bookId);
    const scoped = lessonScopedWordIds(courseBooks, n, { bookId });
    const lessonWordIds = new Set(lesson.vocab);
    const scopeHints = scope.hints;
    const lessonPlan = plan?.find((p) => p.n === n);
    if (plan && !lessonPlan) fail(`${L}: not in ${planFileHint(bookId)}`);

    const check = (where: string, zh: string): boolean => {
      const r = scope.check(zh);
      if (!r.pass) {
        const bad = r.unknown.map((u) => u.token.text).join('、');
        const tw = r.taiwanness.isClean ? '' : ' [not Taiwan-clean]';
        fail(`${L} ${where}: "${zh}" — out of scope: ${bad || '(none)'}${tw}`);
        return false;
      }
      return true;
    };

    // ---- sentences
    const seen = new Set<string>();
    let i = 0;
    for (const s of content.sentences) {
      if (seen.has(s.zh)) {
        fail(`${L} duplicate sentence "${s.zh}"`);
        continue;
      }
      seen.add(s.zh);
      i++;
      const ok = check(`sentence ${i}`, s.zh);
      for (const gid of s.grammar) {
        const g = grammarById.get(gid);
        const mine = lesson.grammar.includes(gid);
        if (!g) fail(`${L} sentence "${s.zh}": unknown grammar ${gid}`);
        else if (
          !mine &&
          (courseOrdinal(LAIXUE_COURSE, g.bookId, g.lesson) ?? 99) >
            (courseOrdinal(LAIXUE_COURSE, bookId, n) ?? 0)
        )
          fail(`${L} sentence "${s.zh}": grammar ${gid} is from ${g.bookId} lesson ${g.lesson}`);
        else if (!matcherOf(gid).test(s.zh))
          fail(`${L} sentence "${s.zh}": does not match pattern of ${gid}`);
      }
      // Phase 25 content fields: same characters reordered, a real difference, tiles that spell it.
      const sorted = (x: string) => [...x.replace(/[\s，。？！、]/gu, '')].sort().join('');
      for (const alt of s.altOrders ?? [])
        if (alt === s.zh || sorted(alt) !== sorted(s.zh)) fail(`${L} sentence "${s.zh}": altOrder "${alt}" is not a reordering`);
      if (s.wrong !== undefined && (s.wrong === s.zh || !check(`sentence ${i} wrong`, s.wrong)))
        fail(`${L} sentence "${s.zh}": wrong version "${s.wrong}" must differ and use only allowed words`);
      if (s.tiles && s.tiles.join('') !== s.zh) fail(`${L} sentence "${s.zh}": tiles do not spell the sentence`);
      if (!ok) continue;
      const tokens = segment(s.zh, lexicon, { hints: scopeHints(s.zh) }).filter(
        (t) => t.kind === 'word' || t.kind === 'latin',
      );
      const target =
        tokens
          .map((t) => lexicon.lookup(t.text).find((w) => lessonWordIds.has(w.id)))
          .find((w): w is Word => !!w) ??
        tokens.map((t) => lexicon.lookup(t.text)[0]).find((w): w is Word => !!w);
      if (!target) {
        fail(`${L} sentence "${s.zh}": no target word`);
        continue;
      }
      allSentences.push({
        id: `${idPrefix}-L${String(n).padStart(2, '0')}-${String(i).padStart(3, '0')}`,
        zh: s.zh,
        en: s.en,
        targetWordId: target.id,
        level,
        tokens: tokens.map((t) => ({ text: t.text })),
        source: 'generated',
        doubtful: false,
        tags: [textbookTag(bookId), lessonTag(n, bookId)],
        lesson: n,
        ...(bookId === 'laixue-1' ? {} : { textbookId: bookId }),
        grammarIds: s.grammar,
        ...(s.altOrders ? { altOrders: s.altOrders } : {}),
        ...(s.wrong ? { wrong: s.wrong } : {}),
        ...(s.tiles ? { tiles: s.tiles } : {}),
      });
    }
    if (content.sentences.length < MIN_SENTENCES)
      fail(`${L}: only ${content.sentences.length} sentences (need ${MIN_SENTENCES}+)`);
    const used = new Set(content.sentences.flatMap((s) => s.grammar));
    for (const g of lesson.grammar) if (!used.has(g)) fail(`${L}: no sentence exercises ${g}`);

    // ---- scenarios
    const scenarioIds: string[] = [];
    const minSteps = MIN_GOAL_STEPS[bookId] ?? 1;
    for (const sc of content.scenarios) {
      const id = `${bookId}-L${String(n).padStart(2, '0')}-${sc.slug}`;
      scenarioIds.push(id);
      check(`scenario ${sc.slug} opener`, sc.opener.zh);
      check(`scenario ${sc.slug} successLine`, sc.successLine.zh);
      if (sc.goalSteps.length < minSteps)
        fail(`${L} scenario ${sc.slug}: ${sc.goalSteps.length} goal steps (${bookId} needs ${minSteps}+)`);
      const planned = lessonPlan?.scenarios.find((p) => p.slug === sc.slug);
      if (lessonPlan && !planned) fail(`${L} scenario ${sc.slug}: not in the lesson plan`);
      if (planned && planned.npcId !== sc.npc.id)
        fail(`${L} scenario ${sc.slug}: the plan says NPC "${planned.npcId}", content has "${sc.npc.id}"`);
      for (const extra of sc.vocabExtras) {
        const w = lexicon.lookup(extra).find((x) => scoped.has(x.id));
        if (!w)
          fail(`${L} scenario ${sc.slug}: vocabExtra "${extra}" is not a course word up to this lesson`);
      }
      for (const h of sc.goalSteps.flatMap((g) => g.keywordHints))
        check(`scenario ${sc.slug} keyword`, h);
      const scenario = ScenarioSchema.parse({
        id,
        title: sc.title,
        levelRange: bookId === 'laixue-1' ? { min: 'N1', max: 'N2' } : { min: level, max: level },
        npc: sc.npc,
        setting: sc.setting,
        goalSteps: sc.goalSteps,
        vocabExtras: sc.vocabExtras,
        opener: sc.opener,
        successLine: sc.successLine,
        textbook: { textbookId: bookId, lesson: n },
      });
      writeFileSync(
        path.join(REPO, 'data/scenarios', `${id}.yaml`),
        `# GENERATED by build-textbook-content from data/curriculum/${bookId}/content/${file}\n` +
          yaml.dump(scenario, { lineWidth: 100 }),
        'utf8',
      );
    }
    if (scenarioIds.length === 0) fail(`${L}: no scenario`);
    if (lessonPlan)
      for (const p of lessonPlan.scenarios)
        if (!content.scenarios.some((s) => s.slug === p.slug))
          fail(`${L}: the plan lists scenario "${p.slug}" but the content has none`);

    // ---- journal prompts
    const prompts: JournalPrompt[] = [];
    const minPromptGrammar = MIN_PROMPT_GRAMMAR[bookId] ?? 1;
    content.journalPrompts.forEach((p, idx) => {
      const useWords: string[] = [];
      for (const h of p.words) {
        const w = lexicon.lookup(h).find((x) => lessonWordIds.has(x.id));
        if (!w) fail(`${L} prompt ${idx + 1}: "${h}" is not a core word of the lesson`);
        else useWords.push(w.id);
      }
      for (const g of p.grammar)
        if (!lesson.grammar.includes(g) && !grammarById.has(g))
          fail(`${L} prompt ${idx + 1}: grammar ${g} is not a lesson point`);
      if (!p.grammar.some((g) => lesson.grammar.includes(g)))
        fail(`${L} prompt ${idx + 1}: uses none of the lesson's own grammar points`);
      if (p.grammar.length < minPromptGrammar)
        fail(`${L} prompt ${idx + 1}: ${bookId} prompts must use ${minPromptGrammar} grammar points`);
      if (p.zh) check(`prompt ${idx + 1} zh`, p.zh);
      prompts.push({
        id: `${lesson.id}-jp${idx + 1}`,
        lessonId: lesson.id,
        promptEn: p.en,
        ...(p.zh ? { promptZh: p.zh } : {}),
        useWords,
        useGrammar: p.grammar,
        level,
      });
    });
    if (prompts.length < MIN_PROMPTS) fail(`${L}: only ${prompts.length} journal prompts`);
    if (lessonPlan && lessonPlan.prompts.length !== prompts.length)
      fail(`${L}: the plan has ${lessonPlan.prompts.length} journal prompts, content has ${prompts.length}`);

    lesson.scenarios = scenarioIds;
    lesson.journalPrompts = prompts;
    stats.push(
      `${L}: ${content.sentences.length} sentences, ${scenarioIds.length} scenario(s), ${prompts.length} prompts`,
    );
  }

  console.log(stats.join('\n'));
  if (errors.length) return;

  allSentences.sort((a, b) => a.id.localeCompare(b.id));
  // GrammarItem.examples = ids of our sentences that exercise the point (first 6).
  for (const g of book.grammarItems) {
    g.examples = allSentences
      .filter((s) => s.grammarIds?.includes(g.id))
      .slice(0, 6)
      .map((s) => s.id);
  }
  // Phase 25: the grammar items follow their source (pattern, explanation, signal words, matcher).
  for (const g of book.grammarItems) {
    const src = ownGrammar.find((x) => x.id === g.id);
    if (!src) continue;
    g.pattern = src.pattern;
    g.explanationEn = src.explanationEn;
    g.focus = [...src.focus];
    g.matcher = src.matcher;
  }
  writeFileSync(
    path.join(REPO, 'data/build', `sentences.textbook-${bookId}.json`),
    JSON.stringify(
      {
        meta: { version: 'v1', buildDate: book.meta.buildDate, level: courseLessonLevel(LAIXUE_COURSE, bookId, 1) },
        sentences: allSentences,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(BOOK_FILE, JSON.stringify(book, null, 2) + '\n', 'utf8');
  console.log(`${bookId}: wrote ${allSentences.length} sentences; updated book.json. Now run build:scenarios.`);
}

function main(): void {
  const arg = process.argv[2] ?? 'all';
  const ids = arg === 'all' ? configuredBooks().filter((b) => existsSync(path.join(REPO, 'data/curriculum', b, 'content'))) : [arg];
  const lexicon = loadLexicon();
  const allBooks = new Map<string, BookShape>();
  for (const id of configuredBooks()) {
    const f = path.join(REPO, 'data/curriculum', id, 'book.json');
    if (existsSync(f)) allBooks.set(id, JSON.parse(readFileSync(f, 'utf8')) as BookShape);
  }
  for (const id of ids) {
    buildBook(id, lexicon, allBooks);
    if (errors.length) break;
  }
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
}

main();
