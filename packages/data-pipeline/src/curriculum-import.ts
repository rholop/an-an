/**
 * `pnpm curriculum:import laixue-1` — extract 來學華語 第一冊 from the PDF,
 * link every word to the lexicon, write book.json / supplement yaml /
 * private dialogue + example files / import-report.md.
 *
 * Re-runnable: keeps the generated `scenarios` and `journalPrompts` already
 * in book.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  Lexicon,
  lessonTag,
  textbookTag,
  type GrammarItem,
  type Lesson,
  type TextbookFile,
  type Word,
} from '@anan/core';
import { stableId } from './lib/ids.js';
import { parseDialogue, parseExamples, type BookExample } from './lib/curriculum/dialogue-parse.js';
import { LAIXUE1_GRAMMAR } from './lib/curriculum/grammar-points.js';
import {
  linkBookWord,
  linkVariantForms,
  pinyinOptions,
  type LinkResult,
} from './lib/curriculum/link.js';
import { parseLessonFront, parseToc } from './lib/curriculum/objectives.js';
import { buildReport, type ImportStats } from './lib/curriculum/report.js';
import { entryToWord, parseVocabBlock, type BookWord } from './lib/curriculum/vocab-parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const BOOK_ID = 'laixue-1';
const DIR = path.join(REPO, 'data/curriculum', BOOK_ID);
const PRIVATE = path.join(DIR, 'private');
const PDF = path.join(REPO, 'data/raw/textbook/laixue-1.pdf');
const LEXICON = path.join(REPO, 'data/build/lexicon.v2.json');
const SUPPLEMENT = path.join(REPO, 'data/supplement/textbook-laixue-1.yaml');

/** Lesson n starts at PDF page = printed page + 12. */
export const LESSON_START_PAGES = [13, 25, 37, 53, 69, 85, 101, 117, 133, 151];
const END_PAGE = 164; // pronunciation/culture pages of lesson 10 end before the culture notes

/** Repeated headwords the book teaches as a NEW sense (so they count as new words). */
const DISTINCT_SENSES = new Set(['家', '要']);

/** Names used in the dialogues that aren't separate vocabulary entries. */
const EXTRA_NAMES: Array<{ headword: string; pinyin: string; glossEn: string; lesson: number }> = [
  { headword: '明文', pinyin: 'Míngwén', glossEn: 'Mingwen (given name)', lesson: 1 },
  { headword: '家文', pinyin: 'Jiāwén', glossEn: 'Jiawen (given name)', lesson: 1 },
  { headword: '王家文', pinyin: 'Wáng Jiāwén', glossEn: 'Wang Jiawen (name)', lesson: 1 },
  { headword: '學文', pinyin: 'Xuéwén', glossEn: 'Xuewen (given name)', lesson: 3 },
  { headword: '王學文', pinyin: 'Wáng Xuéwén', glossEn: 'Wang Xuewen (name)', lesson: 3 },
  { headword: '美美', pinyin: 'Měiměi', glossEn: 'Meimei (given name)', lesson: 7 },
  { headword: '美生', pinyin: 'Měishēng', glossEn: 'Meisheng (given name)', lesson: 3 },
  { headword: '小生', pinyin: 'Xiǎoshēng', glossEn: 'Xiaosheng (given name)', lesson: 3 },
  { headword: '小文', pinyin: 'Xiǎowén', glossEn: 'Xiaowen (given name)', lesson: 4 },
  { headword: '王小文', pinyin: 'Wáng Xiǎowén', glossEn: 'Wang Xiaowen (name)', lesson: 5 },
  { headword: '李', pinyin: 'Lǐ', glossEn: 'Li (surname)', lesson: 4 },
  { headword: '安安', pinyin: 'Ān’ān', glossEn: 'Anan (given name)', lesson: 3 },
  { headword: '明美', pinyin: 'Míngměi', glossEn: 'Mingmei (given name)', lesson: 3 },
];

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

interface RawPages {
  pages: Record<string, string>;
}

function loadPages(): RawPages {
  mkdirSync(PRIVATE, { recursive: true });
  const out = path.join(PRIVATE, 'pages.json');
  if (!existsSync(out)) {
    if (!existsSync(PDF)) throw new Error(`Put the textbook PDF at ${PDF}`);
    sh('python3', [path.join(HERE, '../python/extract_pages.py'), PDF, out]);
  }
  return JSON.parse(readFileSync(out, 'utf8'));
}

function glossSim(a: string, b: string): number {
  const t = (x: string) =>
    new Set(
      x
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const A = t(a);
  const B = t(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

function lessonId(n: number): string {
  return `${BOOK_ID}-L${String(n).padStart(2, '0')}`;
}

function main(): void {
  const { pages } = loadPages();
  const page = (n: number) => pages[String(n)] ?? '';
  const lexData = JSON.parse(readFileSync(LEXICON, 'utf8')) as {
    words: Word[];
    grammar: GrammarItem[];
    meta: { version: string };
  };
  // Link against the lexicon WITHOUT previous textbook entries so a rebuild after
  // this import resolves to the same ids.
  const lexicon = new Lexicon(lexData.words.filter((w) => w.source !== 'textbook'));

  const prev: Partial<TextbookFile> = existsSync(path.join(DIR, 'book.json'))
    ? JSON.parse(readFileSync(path.join(DIR, 'book.json'), 'utf8'))
    : {};
  const prevLessons = new Map((prev.textbook?.lessons ?? []).map((l) => [l.id, l]));

  const stats: ImportStats = {
    lessons: [],
    totalEntries: 0,
    statedWords: 223,
    statedGrammar: 34,
    cleanups: [],
    unlinked: [],
    weakLinks: [],
    indexMissing: [],
    duplicates: [],
    manual: [],
    dialogueNotes: [],
    grammarCount: LAIXUE1_GRAMMAR.length,
  };

  const toc = parseToc(`${page(8)}\n${page(9)}`);
  if (toc.length !== 10)
    stats.manual.push(
      `Contents page parsed ${toc.length} titles (expected 10); lesson titles may be wrong.`,
    );

  const allBookWords: BookWord[] = [];
  const lessons: Lesson[] = [];
  const dialogues: Record<
    string,
    { lessonId: string; lines: Array<{ speaker: string; zh: string }> }
  > = {};
  const examples: Record<string, BookExample[]> = {};
  const links = new Map<BookWord, LinkResult>();
  const supplementOut = new Map<string, Record<string, unknown>>();
  const extraForms: Array<{ word: BookWord; extra: Word }> = [];
  const grammarNotes: Array<{
    wordId: string;
    lesson: number;
    headword: string;
    pinyin: string;
    glossEn: string;
  }> = [];

  for (let n = 1; n <= 10; n++) {
    const start = LESSON_START_PAGES[n - 1]!;
    const next = LESSON_START_PAGES[n] ?? END_PAGE;
    const front = { ...parseLessonFront(page(start)), ...(toc.find((t) => t.n === n) ?? {}) };

    // Vocabulary pages: from the dialogue-word page to one page after the 語法 heading.
    const vocabPages: string[] = [];
    let seenGrammar = false;
    for (let p = start + 2; p < next; p++) {
      const t = page(p);
      vocabPages.push(t);
      if (seenGrammar) break;
      if (/語法\s*Grammar/.test(t)) seenGrammar = true;
    }
    const raw = parseVocabBlock(vocabPages, { titleZh: front.titleZh, titleEn: front.titleEn });
    const words = raw.map((e) => entryToWord(n, e));
    for (const w of words) {
      const rawHead = raw.find((r) => r.n === w.n)?.lines[0] ?? '';
      if (
        /[㐀-鿿]{2,}[㐀-鿿]$/.test(rawHead) &&
        !rawHead.startsWith(w.headword + w.headword.at(-1))
      ) {
        // fall through; precise ruby cleanups are logged below by comparing raw/clean
      }
      if (
        rawHead &&
        rawHead.replace(/\s+/g, '') !== w.headword &&
        rawHead.split('/')[0]!.trim() !== w.headword
      ) {
        stats.cleanups.push(
          `L${n} #${w.n}: "${rawHead.trim()}" → "${w.headword}"${w.variants.length ? ` (variants ${w.variants.join(', ')})` : ''}`,
        );
      }
    }
    allBookWords.push(...words);

    // Dialogue + examples (private).
    let dlg: ReturnType<typeof parseDialogue> = { lines: [], dropped: [] };
    const exs: BookExample[] = [];
    for (let p = start; p < next; p++) {
      const t = page(p);
      if (t.includes('Read aloud')) dlg = parseDialogue(t);
      if (p > start + 2) exs.push(...parseExamples(t));
    }
    dialogues[lessonId(n)] = { lessonId: lessonId(n), lines: dlg.lines };
    examples[lessonId(n)] = exs.map((e) => ({ ...e, zh: e.zh.replace(/^[AB]：/, '') }));
    for (const d of dlg.dropped) stats.dialogueNotes.push(`L${n}: dropped "${d}"`);

    // Link words.
    const vocabIds: string[] = [];
    const suppIds: string[] = [];
    const properIds: string[] = [];
    for (const w of words) {
      const isNameGloss =
        w.section === 'proper' || /example of a (sur)?name|\(a surname\)/i.test(w.glossEn);
      const link: LinkResult = isNameGloss
        ? { tier: 'none', overlap: 0 }
        : linkBookWord(w, lexicon);
      links.set(w, link);
      let id: string;
      if (link.word) {
        id = link.word.id;
        const suspicious = link.word.level !== null && ['L3', 'L4', 'L5'].includes(link.word.level);
        if ((link.tier !== 'exact' && link.overlap < 0.34) || suspicious) {
          stats.weakLinks.push(
            `L${n} #${w.n} ${w.headword} (${w.pinyin}, "${w.glossEn}") → ${link.word.headword} ${link.word.pinyin} "${link.word.glossEn}" [${link.tier}, gloss overlap ${link.overlap.toFixed(2)}]`,
          );
        }
      } else {
        const hint = pinyinOptions(w.pinyin)[0] ?? w.pinyin;
        id = stableId('tb', w.headword, hint, BOOK_ID);
        stats.unlinked.push(
          `L${n} #${w.n} ${w.headword} (${w.pinyin}) "${w.glossEn}" → new textbook entry ${id}`,
        );
        const isName = isNameGloss;
        const key = `${w.headword}|${hint}`;
        const tags = [textbookTag(), lessonTag(n)];
        if (isName) tags.push('name');
        const existing = supplementOut.get(key);
        if (existing) {
          const t = existing.tags as string[];
          if (!t.includes(lessonTag(n))) t.push(lessonTag(n));
        } else {
          supplementOut.set(key, {
            headword: w.headword,
            variants: w.variants,
            pos: w.pos,
            level: 'N1',
            pinyin: hint,
            glossEn: w.glossEn,
            tags,
          });
        }
      }
      const into = w.section === 'supplementary' ? suppIds : vocabIds;
      into.push(id);
      if (link.word) {
        for (const extra of linkVariantForms(w, lexicon, link.word)) {
          into.push(extra.id);
          extraForms.push({ word: w, extra });
        }
      }
      if (w.section === 'proper' || isNameGloss) properIds.push(id);
    }

    for (const nm of EXTRA_NAMES.filter((e) => e.lesson === n)) {
      const hint = nm.pinyin;
      if (lexicon.lookup(nm.headword).some((x) => x.tags.includes('name'))) continue;
      const id = stableId('tb', nm.headword, hint, BOOK_ID);
      properIds.push(id);
      supplementOut.set(`${nm.headword}|${hint}`, {
        headword: nm.headword,
        variants: [],
        pos: ['N'],
        level: 'N1',
        pinyin: hint,
        glossEn: nm.glossEn,
        tags: [textbookTag(), lessonTag(n), 'name'],
      });
    }

    // Function words introduced by the grammar points (的, 呢, 星期一 …).
    const grammarWordIds: string[] = [];
    for (const g of LAIXUE1_GRAMMAR.filter((x) => x.lesson === n)) {
      for (const h of g.words ?? []) {
        const w = lexicon.lookup(h).find((x) => x.source !== 'textbook');
        if (!w) {
          stats.manual.push(`L${n}: grammar word ${h} (${g.id}) is not in the lexicon`);
          continue;
        }
        grammarWordIds.push(w.id);
        grammarNotes.push({
          wordId: w.id,
          lesson: n,
          headword: w.headword,
          pinyin: w.pinyin,
          glossEn: w.glossEn,
        });
      }
    }

    const lid = lessonId(n);
    const old = prevLessons.get(lid);
    const grammar = LAIXUE1_GRAMMAR.filter((g) => g.lesson === n).map((g) => g.id);
    lessons.push({
      id: lid,
      n,
      titleZh: front.titleZh,
      titleEn: front.titleEn,
      topic: front.topic,
      objectives: front.objectives,
      vocab: [...new Set(vocabIds)],
      supplementary: [...new Set(suppIds)],
      grammarWords: [...new Set(grammarWordIds)].filter(
        (id) => !vocabIds.includes(id) && !suppIds.includes(id),
      ),
      properNouns: [...new Set(properIds)],
      grammar,
      dialogueRef: `dialogues.json#${lid}`,
      scenarios: old?.scenarios ?? [],
      journalPrompts: old?.journalPrompts ?? [],
    });
    stats.lessons.push({
      n,
      titleEn: front.titleEn,
      counts: {
        core: words.filter((w) => w.section === 'core').length,
        phrase: words.filter((w) => w.section === 'phrase').length,
        proper: words.filter((w) => w.section === 'proper').length,
        supplementary: words.filter((w) => w.section === 'supplementary').length,
      },
      grammar: grammar.length,
      examples: examples[lid]!.length,
      dialogueLines: dlg.lines.length,
    });
  }
  stats.totalEntries = allBookWords.length;

  // Repeats across lessons ("new words" count each headword once).
  const byKey = new Map<string, BookWord[]>();
  for (const w of allBookWords)
    byKey.set(`${w.headword}|${pinyinOptions(w.pinyin)[0]}`, [
      ...(byKey.get(`${w.headword}|${pinyinOptions(w.pinyin)[0]}`) ?? []),
      w,
    ]);
  for (const [k, ws] of byKey)
    if (ws.length > 1)
      stats.duplicates.push(
        `${k.split('|')[0]} — ${ws.map((w) => `L${w.lesson} #${w.n}`).join(', ')}`,
      );
  // The book counts a repeat of the same word AND sense once (和, 今天), but 家 and 要 are new senses.
  let sameSense = 0;
  for (const ws of byKey.values()) {
    const kept: BookWord[] = [];
    for (const w of ws) {
      if (
        !DISTINCT_SENSES.has(w.headword) &&
        kept.some((k) => glossSim(k.glossEn, w.glossEn) >= 0.5)
      )
        sameSense++;
      else kept.push(w);
    }
  }
  stats.uniqueWords = allBookWords.length - sameSense;

  // Cross-check against the appendix vocabulary index (PDF p174+).
  const indexText = Array.from({ length: 9 }, (_, i) => page(174 + i)).join('\n');
  const indexLines = new Set(
    indexText
      .split('\n')
      .flatMap((l) => l.split('/').map((x) => x.trim()))
      .filter(Boolean),
  );
  for (const w of allBookWords) {
    if (w.section === 'proper' && !/[㐀-鿿]/.test(w.headword)) continue;
    const forms = [w.headword, ...w.variants];
    if (!forms.some((f) => indexLines.has(f)))
      stats.indexMissing.push(`L${w.lesson} #${w.n} ${w.headword} (${w.pinyin})`);
  }

  stats.manual.push(
    `All ${LAIXUE1_GRAMMAR.length} grammar points were transcribed by hand (packages/data-pipeline/src/lib/curriculum/grammar-points.ts); the 語法 headings do not extract cleanly.`,
    'Repeats of the same word and sense (和 L3/L6, 今天 L4/L8) count once; 家 (home → measure word for shops) and 要 (want → want to) are new senses and count again: 225 − 2 = 223.',
    'Explanations in grammar-points.ts are written for this app, not copied.',
    'EXTRA_NAMES (curriculum-import.ts) lists character names used in the dialogues that are not separate vocabulary entries.',
  );

  // ---- write outputs
  const grammarItems: GrammarItem[] = LAIXUE1_GRAMMAR.map((g) => ({
    id: g.id,
    pattern: g.pattern,
    level: 'N1',
    explanationEn: g.explanationEn,
    // keep what the content build wrote (our sentence ids); it refills them on every run
    examples:
      ((prev as { grammarItems?: GrammarItem[] }).grammarItems ?? []).find((x) => x.id === g.id)
        ?.examples ?? [],
    tags: [textbookTag(), lessonTag(g.lesson)],
    focus: g.focus,
  }));
  const wordNotes = allBookWords.map((w) => {
    const l = links.get(w)!;
    const id =
      l.word?.id ?? stableId('tb', w.headword, pinyinOptions(w.pinyin)[0] ?? w.pinyin, BOOK_ID);
    return {
      wordId: id,
      lesson: w.lesson,
      n: w.n,
      section: w.section,
      headword: w.headword,
      pinyin: w.pinyin,
      pos: w.pos,
      glossEn: w.glossEn,
    };
  });

  for (const { word, extra } of extraForms) {
    wordNotes.push({
      wordId: extra.id,
      lesson: word.lesson,
      n: word.n,
      section: word.section,
      headword: extra.headword,
      pinyin: word.pinyin,
      pos: word.pos,
      glossEn: word.glossEn,
    });
  }
  for (const g of grammarNotes) {
    if (!wordNotes.some((w) => w.wordId === g.wordId && w.lesson === g.lesson)) {
      wordNotes.push({
        wordId: g.wordId,
        lesson: g.lesson,
        n: 0,
        section: 'grammar' as never,
        headword: g.headword,
        pinyin: g.pinyin,
        pos: [],
        glossEn: g.glossEn,
      });
    }
  }
  const file: TextbookFile & { grammarItems: GrammarItem[]; wordNotes: typeof wordNotes } = {
    meta: { version: 'v1', buildDate: new Date().toISOString().slice(0, 10) },
    textbook: {
      id: BOOK_ID,
      titleZh: '來學華語 第一冊',
      titleEn: "Let's Learn Mandarin 1",
      lessons,
    },
    grammarItems,
    wordNotes,
  };
  const sortedJson = JSON.stringify(file, null, 2) + '\n';
  // Keep buildDate stable if nothing else changed.
  const bookPath = path.join(DIR, 'book.json');
  if (existsSync(bookPath)) {
    const prevFile = JSON.parse(readFileSync(bookPath, 'utf8')) as typeof file;
    const same =
      JSON.stringify({ ...prevFile, meta: null }) === JSON.stringify({ ...file, meta: null });
    if (same) file.meta.buildDate = prevFile.meta.buildDate;
  }
  writeFileSync(bookPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
  void sortedJson;
  writeFileSync(
    path.join(PRIVATE, 'dialogues.json'),
    JSON.stringify(dialogues, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    path.join(PRIVATE, 'examples.json'),
    JSON.stringify(examples, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    SUPPLEMENT,
    `# GENERATED by \`pnpm curriculum:import ${BOOK_ID}\` — words in 來學華語 第一冊 that the lexicon lacks.\n# source: textbook, level N1; readings are verified against MOE by build-lexicon like any supplement.\n` +
      yaml.dump([...supplementOut.values()], { lineWidth: 120 }),
    'utf8',
  );
  writeFileSync(path.join(DIR, 'import-report.md'), buildReport(stats), 'utf8');
  console.log(
    `Imported ${allBookWords.length} entries (${stats.uniqueWords} unique), ${LAIXUE1_GRAMMAR.length} grammar points; ${supplementOut.size} new lexicon entries. Report: ${path.join(DIR, 'import-report.md')}`,
  );
  if (supplementOut.size > 0)
    console.log('Now run: pnpm --filter @anan/data-pipeline build:lexicon');
}

main();
