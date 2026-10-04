/**
 * `pnpm curriculum:import <bookId>` (laixue-1 … laixue-4) — extract one 來學華語
 * volume from its PDF, link every word to the lexicon, write book.json /
 * supplement yaml / private dialogue + example files / import-report.md.
 *
 * Everything about a book's layout comes from `data/curriculum/<bookId>/config.json`
 * (lesson start pages, section headings, appendix index pages, stated counts);
 * nothing is hard-coded for book 1.
 *
 * Re-runnable: keeps the generated `scenarios` and `journalPrompts` already
 * in book.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  courseLessonLevel,
  Lexicon,
  LAIXUE_COURSE,
  lessonTag,
  textbookTag,
  type GrammarItem,
  type Lesson,
  type TextbookFile,
  type Word,
} from '@anan/core';
import { stableId } from './lib/ids.js';
import { parseDialogue, parseExamples, type BookExample } from './lib/curriculum/dialogue-parse.js';
import { BookConfigSchema, type BookConfig } from './lib/curriculum/book-config.js';
import { loadBookGrammar } from './lib/curriculum/grammar-source.js';
import { parseVocabIndex, type IndexEntry } from './lib/curriculum/index-parse.js';
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
const LEXICON = path.join(REPO, 'data/build/lexicon.v2.json');

export function loadBookConfig(bookId: string): BookConfig {
  const file = path.join(REPO, 'data/curriculum', bookId, 'config.json');
  if (!existsSync(file)) throw new Error(`No ${file}. Create it from the book's contents page.`);
  const cfg = BookConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (cfg.bookId !== bookId) throw new Error(`${file}: bookId is ${cfg.bookId}`);
  return cfg;
}

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

interface RawPages {
  pages: Record<string, string>;
}

function loadPages(cfg: BookConfig, dir: string): RawPages {
  const priv = path.join(dir, 'private');
  mkdirSync(priv, { recursive: true });
  const out = path.join(priv, 'pages.json');
  if (!existsSync(out)) {
    const pdf = path.join(REPO, 'data/raw/textbook', `${cfg.bookId}.pdf`);
    if (!existsSync(pdf)) throw new Error(`Put the textbook PDF at ${pdf}`);
    sh('python3', [
      path.join(HERE, '../python/extract_pages.py'),
      pdf,
      out,
      ...(cfg.glyphDecode ? ['--glyph-decode'] : []),
    ]);
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

/** Book ids of the course, in order. */
const BOOK_ORDER = LAIXUE_COURSE.books.map((b) => b.id);

function supplementPath(bookId: string): string {
  return path.join(REPO, 'data/supplement', `textbook-${bookId}.yaml`);
}

/**
 * Entries earlier books already created (words the lexicon lacked). A word
 * that appears again in a later book must reuse that id, so it stays ONE item
 * carrying both books' tags.
 */
function priorSupplementIds(bookId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const earlier of BOOK_ORDER.slice(0, BOOK_ORDER.indexOf(bookId))) {
    const file = supplementPath(earlier);
    if (!existsSync(file)) continue;
    const entries = (yaml.load(readFileSync(file, 'utf8')) as Array<{
      headword: string;
      pinyin: string;
    }> | null) ?? [];
    for (const e of entries) {
      const key = `${e.headword}|${e.pinyin}`;
      if (!out.has(key)) out.set(key, stableId('tb', e.headword, e.pinyin, earlier));
    }
  }
  return out;
}

/** The earliest book whose tag a textbook-source word carries (its home book). */
function homeBookIndex(w: Word): number {
  let best = Infinity;
  for (const t of w.tags) {
    const m = /^textbook:(laixue-\d+)$/.exec(t);
    if (m) best = Math.min(best, BOOK_ORDER.indexOf(m[1]!));
  }
  return best;
}

export function importBook(bookId: string): void {
  const cfg = loadBookConfig(bookId);
  const DIR = path.join(REPO, 'data/curriculum', bookId);
  const PRIVATE = path.join(DIR, 'private');
  const SUPPLEMENT = supplementPath(bookId);
  const bookIdx = BOOK_ORDER.indexOf(bookId);
  const lessonCount = cfg.lessonStartPages.length;
  const lessonLevelOf = (n: number) => courseLessonLevel(LAIXUE_COURSE, bookId, n);
  const grammarPoints = loadBookGrammar(cfg.grammarSource, DIR);
  const prior = priorSupplementIds(bookId);

  const { pages } = loadPages(cfg, DIR);
  const page = (n: number) => pages[String(n)] ?? '';
  const lexData = JSON.parse(readFileSync(LEXICON, 'utf8')) as {
    words: Word[];
    grammar: GrammarItem[];
    meta: { version: string };
  };
  // Link against the lexicon WITHOUT this book's (and later books') textbook-only
  // entries, so a rebuild after this import resolves to the same ids. Entries
  // created by EARLIER books stay: a repeated word must link to them.
  const lexicon = new Lexicon(
    lexData.words.filter((w) => w.source !== 'textbook' || homeBookIndex(w) < bookIdx),
  );

  const prev: Partial<TextbookFile> = existsSync(path.join(DIR, 'book.json'))
    ? JSON.parse(readFileSync(path.join(DIR, 'book.json'), 'utf8'))
    : {};
  const prevLessons = new Map((prev.textbook?.lessons ?? []).map((l) => [l.id, l]));
  const lessonId = (n: number) => `${bookId}-L${String(n).padStart(2, '0')}`;

  const stats: ImportStats = {
    lessons: [],
    totalEntries: 0,
    statedWords: cfg.stated.words,
    statedGrammar: cfg.stated.grammar,
    cleanups: [],
    unlinked: [],
    weakLinks: [],
    indexMissing: [],
    duplicates: [],
    manual: [],
    dialogueNotes: [],
    grammarCount: grammarPoints.length,
    bookId,
    titleZh: cfg.titleZh,
    indexPages: cfg.indexPages,
    patternEntries: [],
    explanations: cfg.explanations,
  };

  const toc = parseToc(cfg.tocPages.map((n) => page(n)).join('\n'));
  if (toc.length !== lessonCount)
    stats.manual.push(
      `Contents page parsed ${toc.length} titles (expected ${lessonCount}); lesson titles may be wrong.`,
    );

  // Appendix index: independent record of every word and its lesson-n locator.
  const indexPagesText = Array.from(
    { length: cfg.indexPages[1] - cfg.indexPages[0] + 1 },
    (_, i) => page(cfg.indexPages[0] + i),
  );
  const indexEntries = parseVocabIndex(indexPagesText);
  const indexAt = new Map<string, IndexEntry>(
    indexEntries.map((e) => [`${e.lesson}-${e.n}`, e]),
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
  const patternIds = new Set<BookWord>();

  for (let n = 1; n <= lessonCount; n++) {
    const start = cfg.lessonStartPages[n - 1]!;
    const next = cfg.lessonStartPages[n] ?? cfg.endPage;
    const front = { ...parseLessonFront(page(start)), ...(toc.find((t) => t.n === n) ?? {}) };

    // Vocabulary pages: from the dialogue-word page to one page after the 語法 heading.
    const grammarRe = new RegExp(cfg.vocab.grammarHeading);
    const vocabPages: string[] = [];
    let seenGrammar = false;
    for (let p = start + 2; p < next; p++) {
      const t = page(p);
      vocabPages.push(t);
      if (seenGrammar) break;
      if (t.split('\n').some((l) => grammarRe.test(l.trim()))) seenGrammar = true;
    }
    const raw = parseVocabBlock(
      vocabPages,
      { titleZh: front.titleZh, titleEn: front.titleEn },
      {
        sections: cfg.vocab.sections,
        headings: cfg.vocab.headings,
        grammarHeading: cfg.vocab.grammarHeading,
      },
    );
    const words = raw.map((e) => entryToWord(n, e, { dedupeRuby: cfg.rubyDuplicates }));
    for (const w of words) {
      const rawHead = raw.find((r) => r.n === w.n)?.lines[0] ?? '';
      if (
        rawHead &&
        rawHead.replace(/\s+/g, '') !== w.headword &&
        rawHead.split('/')[0]!.trim() !== w.headword
      ) {
        stats.cleanups.push(
          `L${n} #${w.n}: "${rawHead.trim()}" → "${w.headword}"${w.variants.length ? ` (variants ${w.variants.join(', ')})` : ''}`,
        );
      }
      // Text-layer damage: repair the headword from the appendix index (same lesson-n).
      if (w.headword.includes('�')) {
        const fix = indexAt.get(`${n}-${w.n}`);
        if (fix?.headword) {
          stats.cleanups.push(`L${n} #${w.n}: undecodable glyph in headword → "${fix.headword}" (from the index)`);
          w.headword = fix.headword;
        } else {
          stats.manual.push(`L${n} #${w.n}: headword "${w.headword}" contains an undecodable glyph and has no index entry`);
        }
      }
    }
    allBookWords.push(...words);

    // Dialogue + examples (private).
    let dlg: ReturnType<typeof parseDialogue> = { lines: [], dropped: [] };
    const exs: BookExample[] = [];
    for (let p = start; p < next; p++) {
      const t = page(p);
      if (t.includes(cfg.dialogueMarker)) dlg = parseDialogue(t);
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
      // Sentence patterns (太……了, ……的時候) are grammar, not lexicon items.
      if (/[…]/.test(w.headword)) {
        patternIds.add(w);
        stats.patternEntries!.push(`L${n} #${w.n} ${w.headword} (${w.pinyin}) "${w.glossEn}"`);
        continue;
      }
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
        if ((link.tier !== 'exact' && link.overlap < 0.34) || (suspicious && bookIdx === 0)) {
          stats.weakLinks.push(
            `L${n} #${w.n} ${w.headword} (${w.pinyin}, "${w.glossEn}") → ${link.word.headword} ${link.word.pinyin} "${link.word.glossEn}" [${link.tier}, gloss overlap ${link.overlap.toFixed(2)}]`,
          );
        }
      } else {
        const hint = pinyinOptions(w.pinyin)[0] ?? w.pinyin;
        const key = `${w.headword}|${hint}`;
        id = prior.get(key) ?? stableId('tb', w.headword, hint, bookId);
        stats.unlinked.push(
          prior.has(key)
            ? `L${n} #${w.n} ${w.headword} (${w.pinyin}) "${w.glossEn}" → already created by an earlier book (${id})`
            : `L${n} #${w.n} ${w.headword} (${w.pinyin}) "${w.glossEn}" → new textbook entry ${id}`,
        );
        if (!prior.has(key)) {
          const tags = [textbookTag(bookId), lessonTag(n, bookId)];
          if (isNameGloss) tags.push('name');
          const existing = supplementOut.get(key);
          if (existing) {
            const t = existing.tags as string[];
            if (!t.includes(lessonTag(n, bookId))) t.push(lessonTag(n, bookId));
          } else {
            supplementOut.set(key, {
              headword: w.headword,
              variants: w.variants,
              pos: w.pos,
              level: lessonLevelOf(n),
              pinyin: hint,
              glossEn: w.glossEn,
              tags,
            });
          }
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

    for (const nm of cfg.extraNames.filter((e) => e.lesson === n)) {
      const hint = nm.pinyin;
      if (lexicon.lookup(nm.headword).some((x) => x.tags.includes('name'))) continue;
      const id = prior.get(`${nm.headword}|${hint}`) ?? stableId('tb', nm.headword, hint, bookId);
      properIds.push(id);
      if (prior.has(`${nm.headword}|${hint}`)) continue;
      supplementOut.set(`${nm.headword}|${hint}`, {
        headword: nm.headword,
        variants: [],
        pos: ['N'],
        level: lessonLevelOf(n),
        pinyin: hint,
        glossEn: nm.glossEn,
        tags: [textbookTag(bookId), lessonTag(n, bookId), 'name'],
      });
    }

    // Function words introduced by the grammar points (的, 呢, 星期一 …).
    const grammarWordIds: string[] = [];
    for (const xw of cfg.extraWords.filter((e) => e.lesson === n)) {
      const found = lexicon.lookup(xw.headword).find((x) => x.source !== 'textbook');
      const key = `${xw.headword}|${xw.pinyin}`;
      const id = found?.id ?? prior.get(key) ?? stableId('tb', xw.headword, xw.pinyin, bookId);
      grammarWordIds.push(id);
      grammarNotes.push({ wordId: id, lesson: n, headword: xw.headword, pinyin: xw.pinyin, glossEn: xw.glossEn });
      if (!found && !prior.has(key))
        supplementOut.set(key, {
          headword: xw.headword,
          variants: [],
          pos: xw.pos,
          level: lessonLevelOf(n),
          pinyin: xw.pinyin,
          glossEn: xw.glossEn,
          tags: [textbookTag(bookId), lessonTag(n, bookId)],
        });
    }
    for (const g of grammarPoints.filter((x) => x.lesson === n)) {
      for (const h of g.words ?? []) {
        const w = lexicon.lookup(h).find((x) => x.source !== 'textbook') ?? lexicon.lookup(h)[0];
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
    const grammar = grammarPoints.filter((g) => g.lesson === n).map((g) => g.id);
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
  // The book counts a repeat of the same word AND sense once (和, 今天), but a new sense counts again.
  const distinct = new Set(cfg.vocab.distinctSenses);
  let sameSense = 0;
  for (const ws of byKey.values()) {
    const kept: BookWord[] = [];
    for (const w of ws) {
      if (!distinct.has(w.headword) && kept.some((k) => glossSim(k.glossEn, w.glossEn) >= 0.5))
        sameSense++;
      else kept.push(w);
    }
  }
  stats.uniqueWords = allBookWords.length - sameSense;

  // Words an earlier book already taught: one item, tagged by both books.
  const earlierIds = new Map<string, string>();
  for (const earlier of BOOK_ORDER.slice(0, bookIdx)) {
    const f = path.join(REPO, 'data/curriculum', earlier, 'book.json');
    if (!existsSync(f)) continue;
    const eb = JSON.parse(readFileSync(f, 'utf8')) as {
      wordNotes: Array<{ wordId: string; lesson: number; section: string }>;
    };
    for (const n of eb.wordNotes)
      if (n.section !== 'grammar' && !earlierIds.has(n.wordId))
        earlierIds.set(n.wordId, `${earlier} L${n.lesson}`);
  }
  stats.reintroduced = [];
  for (const w of allBookWords) {
    const l = links.get(w);
    const hint = pinyinOptions(w.pinyin)[0] ?? w.pinyin;
    const id = l?.word?.id ?? prior.get(`${w.headword}|${hint}`);
    const where = id ? earlierIds.get(id) : undefined;
    if (where) stats.reintroduced.push(`L${w.lesson} #${w.n} ${w.headword} — first taught in ${where}`);
  }

  // Cross-check against the appendix vocabulary index.
  const indexLines = new Set(
    indexPagesText
      .join('\n')
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
  // Locator check: the index entry at `lesson-n` should be the lesson entry n.
  const byLocator = new Map(allBookWords.map((w) => [`${w.lesson}-${w.n}`, w]));
  let confirmed = 0;
  stats.locatorMismatches = [];
  for (const e of indexEntries) {
    const w = byLocator.get(`${e.lesson}-${e.n}`);
    const forms = w ? [w.headword, ...w.variants].map((f) => f.replace(/\s+/g, '')) : [];
    // The index writes alternates as "a / b" or without punctuation; compare squashed.
    if (w && (forms.includes(e.headword) || forms.some((f) => e.headword.startsWith(f) || f.startsWith(e.headword)))) confirmed++;
    else
      stats.locatorMismatches.push(
        `index ${e.lesson}-${e.n} "${e.headword}" (${e.pinyin}) ↔ ${w ? `parsed "${w.headword}"` : 'no parsed entry'}`,
      );
  }
  stats.locatorChecked = { entries: indexEntries.length, confirmed };

  stats.manual.push(
    cfg.grammarSource === 'builtin:laixue1'
      ? `All ${grammarPoints.length} grammar points were transcribed by hand (packages/data-pipeline/src/lib/curriculum/grammar-points.ts); the 語法 headings do not extract cleanly.`
      : `All ${grammarPoints.length} grammar points are listed in data/curriculum/${bookId}/${cfg.grammarSource}, read from the book's 語法 pages and checked against the stated count.`,
    'Explanations are written for this app, not copied.',
    cfg.extraNames.length
      ? 'extraNames (config.json) lists character names used in the dialogues that are not separate vocabulary entries.'
      : 'No extra character names are needed beyond the vocabulary lists.',
  );
  if (cfg.glyphDecode)
    stats.manual.push(
      'This PDF has fonts without a Unicode map; its text was decoded from glyph ids (packages/data-pipeline/python/extract_pages.py) and every headword was cross-checked against the appendix index.',
    );

  // ---- write outputs
  const grammarItems: GrammarItem[] = grammarPoints.map((g) => ({
    id: g.id,
    pattern: g.pattern,
    level: lessonLevelOf(g.lesson),
    explanationEn: g.explanationEn,
    // keep what the content build wrote (our sentence ids); it refills them on every run
    examples:
      ((prev as { grammarItems?: GrammarItem[] }).grammarItems ?? []).find((x) => x.id === g.id)
        ?.examples ?? [],
    tags: [textbookTag(bookId), lessonTag(g.lesson, bookId)],
    focus: g.focus,
    ...(g.reteaches ? { reteaches: true } : {}),
  })) as GrammarItem[];
  const wordNotes = allBookWords
    .filter((w) => !patternIds.has(w))
    .map((w) => {
      const l = links.get(w)!;
      const hint = pinyinOptions(w.pinyin)[0] ?? w.pinyin;
      const id =
        l.word?.id ?? prior.get(`${w.headword}|${hint}`) ?? stableId('tb', w.headword, hint, bookId);
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
      id: bookId,
      titleZh: cfg.titleZh,
      titleEn: cfg.titleEn,
      lessons,
    },
    grammarItems,
    wordNotes,
  };
  // Keep buildDate stable if nothing else changed.
  const bookPath = path.join(DIR, 'book.json');
  if (existsSync(bookPath)) {
    const prevFile = JSON.parse(readFileSync(bookPath, 'utf8')) as typeof file;
    const same =
      JSON.stringify({ ...prevFile, meta: null }) === JSON.stringify({ ...file, meta: null });
    if (same) file.meta.buildDate = prevFile.meta.buildDate;
  }
  writeFileSync(bookPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
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
    `# GENERATED by \`pnpm curriculum:import ${bookId}\` — words in ${cfg.titleZh} that the lexicon lacks.\n# source: textbook; readings are verified against MOE by build-lexicon like any supplement.\n` +
      yaml.dump([...supplementOut.values()], { lineWidth: 120 }),
    'utf8',
  );
  writeFileSync(path.join(DIR, 'import-report.md'), buildReport(stats), 'utf8');
  console.log(
    `${bookId}: imported ${allBookWords.length} entries (${stats.uniqueWords} unique; book states ${cfg.stated.words}), ${grammarPoints.length} grammar points (book states ${cfg.stated.grammar}); ${supplementOut.size} new lexicon entries. Report: ${path.join(DIR, 'import-report.md')}`,
  );
  if (supplementOut.size > 0)
    console.log('Now run: pnpm --filter @anan/data-pipeline build:lexicon');
}

/** Book ids that have a config.json, in course order. */
export function configuredBooks(): string[] {
  const dir = path.join(REPO, 'data/curriculum');
  return BOOK_ORDER.filter((b) => existsSync(path.join(dir, b, 'config.json')) && readdirSync(dir).includes(b));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: curriculum:import <bookId | all>   (e.g. laixue-2)');
    process.exit(2);
  }
  const all = arg === 'all';
  for (const id of all ? configuredBooks() : [arg]) {
    importBook(id);
    // A later book links against the lexicon, which must already hold the earlier books' new words.
    if (all) execFileSync('npx', ['tsx', path.join(HERE, 'build-lexicon.ts')], { stdio: 'ignore' });
  }
}
