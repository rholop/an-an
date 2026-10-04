#!/usr/bin/env tsx
/**
 * Phase 12 content build: validates the authored per-lesson content
 * (data/curriculum/laixue-1/content/LNN.yaml — sentences, one or two chat
 * scenarios, journal prompts) against the lesson-scoped vocabulary with
 * `analyzeText` + `checkTaiwanness`, then writes
 *   - data/scenarios/laixue-1-LNN-*.yaml        (compiled by build:scenarios)
 *   - data/build/sentences.textbook-laixue-1.json
 *   - scenario ids / journal prompts into data/curriculum/laixue-1/book.json
 *
 * The content was written by hand (no LLM key is configured for the
 * pipeline); the validator is the same one LLM output must pass. Anything
 * that fails is reported and the build exits non-zero.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import {
  lessonScopedWordIds,
  lessonTag,
  Lexicon,
  ScenarioSchema,
  segment,
  textbookTag,
  type GrammarItem,
  type JournalPrompt,
  type SentenceBankEntry,
  type TextbookFile,
  type Word,
} from '@anan/core';
import { LAIXUE1_GRAMMAR } from './lib/curriculum/grammar-points.js';
import { makeScopeChecker } from './lib/curriculum/scope-check.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const BOOK_ID = 'laixue-1';
const DIR = path.join(REPO, 'data/curriculum', BOOK_ID);
const CONTENT_DIR = path.join(DIR, 'content');
const BOOK_FILE = path.join(DIR, 'book.json');

const MIN_SENTENCES = 20;
const MIN_PROMPTS = 3;

const ContentSchema = z.object({
  lesson: z.number().int().min(1).max(10),
  sentences: z.array(
    z.object({ zh: z.string(), en: z.string(), grammar: z.array(z.string()).min(1) }),
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

function main(): void {
  const lexRaw = JSON.parse(
    readFileSync(path.join(REPO, 'data/build/lexicon.v2.json'), 'utf8'),
  ) as {
    words: Word[];
    grammar: GrammarItem[];
  };
  const lexicon = new Lexicon(lexRaw.words, lexRaw.grammar);
  const book = JSON.parse(readFileSync(BOOK_FILE, 'utf8')) as BookShape;
  const grammarById = new Map(LAIXUE1_GRAMMAR.map((g) => [g.id, g]));
  const files = existsSync(CONTENT_DIR)
    ? readdirSync(CONTENT_DIR)
        .filter((f) => /^L\d\d\.yaml$/.test(f))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`No content in ${CONTENT_DIR}`);

  const allSentences: SentenceBankEntry[] = [];
  const stats: string[] = [];

  for (const file of files) {
    const content: Content = ContentSchema.parse(
      yaml.load(readFileSync(path.join(CONTENT_DIR, file), 'utf8')),
    );
    const n = content.lesson;
    const lesson = book.textbook.lessons[n - 1]!;
    const scope = makeScopeChecker(lexicon, book.textbook, n);
    const scoped = lessonScopedWordIds(book.textbook, n);
    const lessonWordIds = new Set(lesson.vocab);
    const scopeHints = scope.hints;

    const check = (where: string, zh: string): boolean => {
      const r = scope.check(zh);
      if (!r.pass) {
        const bad = r.unknown.map((u) => u.token.text).join('、');
        const tw = r.taiwanness.isClean ? '' : ' [not Taiwan-clean]';
        fail(`L${n} ${where}: "${zh}" — out of scope: ${bad || '(none)'}${tw}`);
        return false;
      }
      return true;
    };

    // ---- sentences
    const seen = new Set<string>();
    let i = 0;
    for (const s of content.sentences) {
      if (seen.has(s.zh)) {
        fail(`L${n} duplicate sentence "${s.zh}"`);
        continue;
      }
      seen.add(s.zh);
      i++;
      const ok = check(`sentence ${i}`, s.zh);
      for (const gid of s.grammar) {
        const g = grammarById.get(gid);
        if (!g) fail(`L${n} sentence "${s.zh}": unknown grammar ${gid}`);
        else if (g.lesson > n)
          fail(`L${n} sentence "${s.zh}": grammar ${gid} is from lesson ${g.lesson}`);
        else if (!new RegExp(g.matcher, 'u').test(s.zh))
          fail(`L${n} sentence "${s.zh}": does not match pattern of ${gid}`);
      }
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
        fail(`L${n} sentence "${s.zh}": no target word`);
        continue;
      }
      allSentences.push({
        id: `tb-L${String(n).padStart(2, '0')}-${String(i).padStart(3, '0')}`,
        zh: s.zh,
        en: s.en,
        targetWordId: target.id,
        level: 'N1',
        tokens: tokens.map((t) => ({ text: t.text })),
        source: 'generated',
        doubtful: false,
        tags: [textbookTag(), lessonTag(n)],
        lesson: n,
        grammarIds: s.grammar,
      });
    }
    if (content.sentences.length < MIN_SENTENCES)
      fail(`L${n}: only ${content.sentences.length} sentences (need ${MIN_SENTENCES}+)`);
    const lessonGrammarUsed = new Set(
      content.sentences.flatMap((s) => s.grammar).filter((g) => grammarById.get(g)?.lesson === n),
    );
    for (const g of lesson.grammar)
      if (!lessonGrammarUsed.has(g)) fail(`L${n}: no sentence exercises ${g}`);

    // ---- scenarios
    const scenarioIds: string[] = [];
    for (const sc of content.scenarios) {
      const id = `${BOOK_ID}-L${String(n).padStart(2, '0')}-${sc.slug}`;
      scenarioIds.push(id);
      check(`scenario ${sc.slug} opener`, sc.opener.zh);
      check(`scenario ${sc.slug} successLine`, sc.successLine.zh);
      for (const extra of sc.vocabExtras) {
        const w = lexicon.lookup(extra).find((x) => scoped.has(x.id));
        if (!w)
          fail(
            `L${n} scenario ${sc.slug}: vocabExtra "${extra}" is not a lesson-scoped textbook word`,
          );
      }
      for (const h of sc.goalSteps.flatMap((g) => g.keywordHints))
        check(`scenario ${sc.slug} keyword`, h);
      const scenario = ScenarioSchema.parse({
        id,
        title: sc.title,
        levelRange: { min: 'N1', max: 'N2' },
        npc: sc.npc,
        setting: sc.setting,
        goalSteps: sc.goalSteps,
        vocabExtras: sc.vocabExtras,
        opener: sc.opener,
        successLine: sc.successLine,
        textbook: { textbookId: BOOK_ID, lesson: n },
      });
      writeFileSync(
        path.join(REPO, 'data/scenarios', `${id}.yaml`),
        `# GENERATED by build-textbook-content from data/curriculum/laixue-1/content/${file}\n` +
          yaml.dump(scenario, { lineWidth: 100 }),
        'utf8',
      );
    }
    if (scenarioIds.length === 0) fail(`L${n}: no scenario`);

    // ---- journal prompts
    const prompts: JournalPrompt[] = [];
    content.journalPrompts.forEach((p, idx) => {
      const useWords: string[] = [];
      for (const h of p.words) {
        const w = lexicon.lookup(h).find((x) => lessonWordIds.has(x.id));
        if (!w) fail(`L${n} prompt ${idx + 1}: "${h}" is not a core word of lesson ${n}`);
        else useWords.push(w.id);
      }
      for (const g of p.grammar)
        if (grammarById.get(g)?.lesson !== n)
          fail(`L${n} prompt ${idx + 1}: grammar ${g} is not a lesson-${n} point`);
      if (p.zh) check(`prompt ${idx + 1} zh`, p.zh);
      prompts.push({
        id: `${lesson.id}-jp${idx + 1}`,
        lessonId: lesson.id,
        promptEn: p.en,
        ...(p.zh ? { promptZh: p.zh } : {}),
        useWords,
        useGrammar: p.grammar,
      });
    });
    if (prompts.length < MIN_PROMPTS) fail(`L${n}: only ${prompts.length} journal prompts`);

    lesson.scenarios = scenarioIds;
    lesson.journalPrompts = prompts;
    stats.push(
      `L${n}: ${content.sentences.length} sentences, ${scenarioIds.length} scenario(s), ${prompts.length} prompts`,
    );
  }

  console.log(stats.join('\n'));
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }

  allSentences.sort((a, b) => a.id.localeCompare(b.id));
  // GrammarItem.examples = ids of our sentences that exercise the point (first 6).
  for (const g of book.grammarItems) {
    g.examples = allSentences
      .filter((s) => s.grammarIds?.includes(g.id))
      .slice(0, 6)
      .map((s) => s.id);
  }
  writeFileSync(
    path.join(REPO, 'data/build/sentences.textbook-laixue-1.json'),
    JSON.stringify(
      {
        meta: { version: 'v1', buildDate: book.meta.buildDate, level: 'N1' },
        sentences: allSentences,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(BOOK_FILE, JSON.stringify(book, null, 2) + '\n', 'utf8');
  console.log(
    `Wrote ${allSentences.length} sentences; updated book.json. Now run build:scenarios.`,
  );
}

main();
