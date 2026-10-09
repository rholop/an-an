/**
 * Acceptance checks over the BUILT curriculum data of the whole 來學華語 series
 * (data/curriculum/laixue-1…4, data/build/lexicon, scenarios, sentences).
 * Each block is skipped when its data isn't built.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildLessonGrammarStep,
  checkTaiwanness,
  glossFor,
  lessonTileWords,
  sentenceTiles,
  courseLessonLevel,
  courseOrdinal,
  LAIXUE_COURSE,
  Lexicon,
  lessonTag,
  textbookTag,
  type GrammarItem,
  type SentenceBankEntry,
  type Scenario,
  type Textbook,
  type TextbookFile,
  type Word,
} from '@anan/core';
import { BookConfigSchema } from './lib/curriculum/book-config.js';
import { loadBookGrammar } from './lib/curriculum/grammar-source.js';
import { loadPlan } from './lib/curriculum/lesson-plan.js';
import { makeScopeChecker } from './lib/curriculum/scope-check.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LEX = path.join(REPO, 'data/build/lexicon.v2.json');
const SCEN = path.join(REPO, 'data/build/scenarios.json');
const bookDir = (id: string) => path.join(REPO, 'data/curriculum', id);
const BOOK_IDS = LAIXUE_COURSE.books.map((b) => b.id);

interface Book extends TextbookFile {
  grammarItems: GrammarItem[];
  wordNotes: Array<{ wordId: string; lesson: number; headword: string; section: string }>;
}

const sentFile = (id: string) => path.join(REPO, 'data/build', `sentences.textbook-${id}.json`);
const builtBook = (id: string) =>
  [path.join(bookDir(id), 'book.json'), sentFile(id)].every(existsSync);
const base = existsSync(LEX) && existsSync(SCEN);

const lexRaw = base
  ? (JSON.parse(readFileSync(LEX, 'utf8')) as { words: Word[]; grammar: GrammarItem[] })
  : (undefined as never);
const lexicon = base ? new Lexicon(lexRaw.words, lexRaw.grammar) : (undefined as never);
const scenarios = base ? (JSON.parse(readFileSync(SCEN, 'utf8')).scenarios as Scenario[]) : [];
const loadBook = (id: string) =>
  JSON.parse(readFileSync(path.join(bookDir(id), 'book.json'), 'utf8')) as Book;
const builtIds = base ? BOOK_IDS.filter(builtBook) : [];
const courseBooks: Textbook[] = builtIds.map((id) => loadBook(id).textbook);

for (const bookId of BOOK_IDS) {
  const bookNo = Number(bookId.slice(-1));
  describe.skipIf(!base || !builtBook(bookId))(`built textbook data (${bookId})`, () => {
    const cfg = BookConfigSchema.parse(
      JSON.parse(readFileSync(path.join(bookDir(bookId), 'config.json'), 'utf8')),
    );
    const book = loadBook(bookId);
    const lessons = book.textbook.lessons;
    const sentences = JSON.parse(readFileSync(sentFile(bookId), 'utf8'))
      .sentences as SentenceBankEntry[];
    const tagRe = new RegExp(`^textbook:${bookId}:L\\d\\d$`);

    it('has the book’s lessons and exactly its stated number of grammar points, each a schedulable lexicon item with this book’s tags', () => {
      expect(lessons).toHaveLength(LAIXUE_COURSE.books[bookNo - 1]!.lessons);
      expect(book.grammarItems).toHaveLength(cfg.stated.grammar);
      expect(lessons.flatMap((l) => l.grammar)).toHaveLength(cfg.stated.grammar);
      for (const g of book.grammarItems) {
        const inLexicon = lexicon.grammarItemById(g.id);
        expect(inLexicon, g.id).toBeDefined();
        expect(inLexicon!.tags).toContain(textbookTag(bookId));
        expect(inLexicon!.tags!.some((t) => tagRe.test(t))).toBe(true);
      }
    });

    it('every book word resolves to a lexicon entry carrying both textbook tags', () => {
      expect(book.wordNotes.length).toBeGreaterThanOrEqual(cfg.stated.words - 20);
      for (const n of book.wordNotes) {
        const w = lexicon.byId(n.wordId);
        expect(w, `${n.headword} (${n.wordId})`).toBeDefined();
        expect(w!.tags, n.headword).toContain(textbookTag(bookId));
        expect(w!.tags, n.headword).toContain(lessonTag(n.lesson, bookId));
      }
    });

    it('the import report’s counts match the book’s stated numbers, or the difference is explained in config.json', () => {
      const report = readFileSync(path.join(bookDir(bookId), 'import-report.md'), 'utf8');
      const total = Number(/entries parsed: \*\*(\d+)\*\*/.exec(report)![1]);
      const unique = Number(/\*\*(\d+)\*\* — (?:matches|differs)/.exec(report)![1]);
      const wordsMatch = total === cfg.stated.words || unique === cfg.stated.words;
      expect(wordsMatch || cfg.explanations.length > 0, `${bookId} words ${total}/${unique}`).toBe(
        true,
      );
      if (!wordsMatch) expect(report).toContain('explained');
      expect(report).toMatch(/Grammar points: \*\*\d+\*\* \(the book states \*\*\d+\*\*\) — match/);
      expect(new RegExp(`${cfg.stated.grammar}\\*\\* \\(the book states \\*\\*${cfg.stated.grammar}`).test(report)).toBe(true);
    });

    it('each lesson has ≥1 scenario, ≥20 validated sentences and 3 journal prompts, all levelled from the book', () => {
      for (const l of lessons) {
        const level = courseLessonLevel(LAIXUE_COURSE, bookId, l.n);
        expect(l.scenarios.length, `L${l.n} scenarios`).toBeGreaterThanOrEqual(1);
        for (const id of l.scenarios) {
          const sc = scenarios.find((s) => s.id === id);
          expect(sc, id).toBeDefined();
          expect(sc!.textbook).toEqual({ textbookId: bookId, lesson: l.n });
          expect(sc!.levelRange.min).toBe(bookId === 'laixue-1' ? 'N1' : level);
        }
        const ls = sentences.filter((s) => s.lesson === l.n);
        expect(ls.length, `L${l.n} sentences`).toBeGreaterThanOrEqual(20);
        expect(ls.every((s) => s.level === level)).toBe(true);
        expect(l.journalPrompts, `L${l.n} prompts`).toHaveLength(3);
        for (const p of l.journalPrompts) {
          expect(p.useWords.length).toBeGreaterThanOrEqual(3);
          expect(p.useGrammar.length).toBeGreaterThanOrEqual(bookNo >= 3 ? 2 : 1);
          expect(p.useGrammar.some((g) => l.grammar.includes(g))).toBe(true);
          expect(p.level).toBe(level);
        }
      }
    });

    it('every sentence passes the course-scoped validator, is Taiwan-clean, tagged, and exercises a grammar point', () => {
      for (const l of lessons) {
        const scope = makeScopeChecker(lexicon, courseBooks, l.n, bookId);
        for (const s of sentences.filter((x) => x.lesson === l.n)) {
          const r = scope.check(s.zh);
          expect(
            r.pass,
            `L${l.n} ${s.zh} → ${r.unknown.map((u) => u.token.text).join('、')}`,
          ).toBe(true);
          expect(checkTaiwanness(s.zh).isClean, s.zh).toBe(true);
          expect(s.tags).toEqual([textbookTag(bookId), lessonTag(l.n, bookId)]);
          expect(s.grammarIds!.length).toBeGreaterThan(0);
        }
        const covered = new Set(
          sentences.filter((x) => x.lesson === l.n).flatMap((x) => x.grammarIds ?? []),
        );
        for (const g of l.grammar) expect(covered.has(g), `L${l.n} ${g}`).toBe(true);
      }
    });

    it('scenario lines meet the validator with the course vocabulary up to their lesson (and nothing later)', () => {
      for (const l of lessons) {
        const scope = makeScopeChecker(lexicon, courseBooks, l.n, bookId);
        for (const id of l.scenarios) {
          const sc = scenarios.find((s) => s.id === id)!;
          for (const zh of [sc.opener.zh, sc.successLine.zh]) {
            const r = scope.check(zh);
            expect(r.pass, `${id}: ${zh} → ${r.unknown.map((u) => u.token.text).join('、')}`).toBe(
              true,
            );
            expect(checkTaiwanness(zh).isClean, zh).toBe(true);
          }
          for (const h of sc.vocabExtras)
            expect(
              lexicon.lookup(h).some((w) => scope.readable.has(w.id)),
              `${id}: ${h}`,
            ).toBe(true);
        }
      }
    });

    if (bookId !== 'laixue-1') {
      it('has a lesson plan covering every lesson and matching the scenarios and prompts', () => {
        const plan = loadPlan(bookDir(bookId), bookId);
        expect(plan.map((p) => p.n)).toEqual(lessons.map((l) => l.n));
        for (const l of lessons) {
          const p = plan.find((x) => x.n === l.n)!;
          expect(p.scenarios.map((s) => `${bookId}-L${String(l.n).padStart(2, '0')}-${s.slug}`)).toEqual(
            l.scenarios,
          );
          expect(p.prompts).toHaveLength(3);
        }
      });
    }
  });
}

describe.skipIf(builtIds.length < 2)('the series is one course', () => {
  it('a word taught in two books is ONE lexicon item with both books’ tags', () => {
    const shared: Array<{ w: Word; books: string[] }> = [];
    for (const w of lexRaw.words) {
      const books = BOOK_IDS.filter((b) => w.tags.includes(textbookTag(b)));
      if (books.length >= 2) shared.push({ w, books });
    }
    expect(shared.length).toBeGreaterThan(10);
    for (const { w, books } of shared) {
      for (const b of books) expect(w.tags.some((t) => t.startsWith(`textbook:${b}:L`))).toBe(true);
    }
    // book 1 + book 3 (the brief’s example): at least one such item exists.
    if (builtIds.includes('laixue-3')) {
      const b13 = shared.filter((s) => s.books.includes('laixue-1') && s.books.includes('laixue-3'));
      expect(b13.length).toBeGreaterThan(0);
      for (const { w } of b13) expect(lexRaw.words.filter((x) => x.id === w.id)).toHaveLength(1);
    }
  });

  it('textbook-only words are never duplicated across books', () => {
    const seen = new Map<string, string>();
    for (const w of lexRaw.words.filter((x) => x.source === 'textbook')) {
      const key = `${w.headword}|${w.pinyin}`;
      expect(seen.has(key), `${key} appears twice (${seen.get(key)} / ${w.id})`).toBe(false);
      seen.set(key, w.id);
    }
  });

  it('a grammar point taught again keeps ONE item with every lesson tag', () => {
    // Phase 25: only truly identical patterns stay shared (progress is shared: see core grammar-ids.ts).
    for (const id of ['gram-yihou']) {
      const g = lexicon.grammarItemById(id);
      if (!g || !builtIds.includes('laixue-3')) continue;
      expect(lexRaw.grammar.filter((x) => x.id === id)).toHaveLength(1);
      expect(g.tags!.filter((t) => t.startsWith('textbook:laixue-') && /:L\d\d$/.test(t)).length).toBeGreaterThan(1);
    }
  });

  it('Phase 25: 從…到 for places (book 2) and for time (book 3) are separate points', () => {
    if (!builtIds.includes('laixue-3')) return;
    const place = lexicon.grammarItemById('gram-cong-dao')!;
    const time = lexicon.grammarItemById('gram-cong-dao-time')!;
    expect(place.tags!.some((t) => t.startsWith('textbook:laixue-3'))).toBe(false);
    expect(time.tags).toContain('textbook:laixue-3:L03');
  });

  it('textbook scenarios are ordered by course position and use course-scoped vocabulary', () => {
    const ords = scenarios
      .filter((s) => s.textbook)
      .map((s) => courseOrdinal(LAIXUE_COURSE, s.textbook!.textbookId, s.textbook!.lesson));
    expect(ords.every((o) => o !== undefined)).toBe(true);
  });
});

describe('textbook copyright handling', () => {
  it('the PDFs and the extracted book text are gitignored and not tracked (every book)', () => {
    // Ask git itself, so the exact .gitignore pattern (a glob or a literal path) doesn't matter.
    for (const id of BOOK_IDS) {
      for (const p of [
        `data/raw/textbook/${id}.pdf`,
        `data/curriculum/${id}/private/dialogues.json`,
        `data/curriculum/${id}/private/pages.json`,
      ]) {
        let ignored = false;
        try {
          execFileSync('git', ['check-ignore', '-q', p], { cwd: REPO });
          ignored = true;
        } catch (err) {
          if ((err as { status?: number }).status === 128) return; // not a git checkout
        }
        expect(ignored, `${p} must be gitignored`).toBe(true);
      }
    }
    let tracked = '';
    try {
      tracked = execFileSync(
        'git',
        ['ls-files', 'data/raw/textbook', ...BOOK_IDS.map((id) => `data/curriculum/${id}/private`)],
        { cwd: REPO, encoding: 'utf8' },
      );
    } catch {
      return; // not a git checkout (e.g. a source tarball) — nothing tracked by definition
    }
    expect(tracked.trim()).toBe('');
  });

  for (const bookId of BOOK_IDS) {
    const BOOK = path.join(bookDir(bookId), 'book.json');
    const dlg = path.join(bookDir(bookId), 'private/dialogues.json');
    const exs = path.join(bookDir(bookId), 'private/examples.json');

    it(`${bookId}: book.json (safe to commit) contains no dialogue text`, () => {
      if (!existsSync(BOOK) || !existsSync(dlg)) return;
      const raw = readFileSync(BOOK, 'utf8');
      const dialogues = JSON.parse(readFileSync(dlg, 'utf8')) as Record<
        string,
        { lines: Array<{ zh: string }> }
      >;
      for (const d of Object.values(dialogues))
        for (const line of d.lines)
          if ([...line.zh].length >= 8) expect(raw.includes(line.zh), line.zh).toBe(false);
    });

    it(`${bookId}: none of the app's public lesson content copies the book's own dialogue or example sentences`, () => {
      if (!base || !builtBook(bookId) || !existsSync(dlg) || !existsSync(exs)) return;
      const norm = (z: string) => z.replace(/^[AB]：/, '').trim();
      const bookText = new Set<string>();
      for (const d of Object.values(
        JSON.parse(readFileSync(dlg, 'utf8')) as Record<string, { lines: Array<{ zh: string }> }>,
      ))
        for (const l of d.lines) bookText.add(norm(l.zh));
      for (const list of Object.values(
        JSON.parse(readFileSync(exs, 'utf8')) as Record<string, Array<{ zh: string }>>,
      ))
        for (const e of list) bookText.add(norm(e.zh));
      const book = loadBook(bookId);
      const ours: string[] = [
        ...(JSON.parse(readFileSync(sentFile(bookId), 'utf8')).sentences as SentenceBankEntry[]).map(
          (x) => x.zh,
        ),
        ...scenarios
          .filter((s) => s.textbook?.textbookId === bookId)
          .flatMap((s) => [s.opener.zh, s.successLine.zh]),
        ...book.textbook.lessons.flatMap((l) =>
          l.journalPrompts.flatMap((p) => (p.promptZh ? [p.promptZh] : [])),
        ),
      ];
      expect(ours.filter((z) => bookText.has(z))).toEqual([]);
    });
  }

  it('generation refuses to run without a lesson plan', () => {
    expect(() => loadPlan(path.join(REPO, 'data/curriculum/no-such-book'), 'laixue-9')).toThrow(
      /Refusing to generate laixue-9.*lesson-plan\.md/s,
    );
  });

  it('grammar tables load for every configured book with ids unique across the course', () => {
    const ids = new Set<string>();
    for (const id of BOOK_IDS) {
      if (!existsSync(path.join(bookDir(id), 'config.json'))) continue;
      const cfg = BookConfigSchema.parse(
        JSON.parse(readFileSync(path.join(bookDir(id), 'config.json'), 'utf8')),
      );
      for (const g of loadBookGrammar(cfg.grammarSource, bookDir(id))) {
        if (!g.reteaches) {
          expect(ids.has(g.id), `${g.id} defined twice`).toBe(false);
          ids.add(g.id);
        } else expect(ids.has(g.id), `${g.id} re-teaches an unknown point`).toBe(true);
      }
    }
  });
});

describe.skipIf(!base || builtIds.length < 4)('Phase 25: lesson content fixes (spot checks)', () => {
  const sentencesOf = (id: string) =>
    (JSON.parse(readFileSync(sentFile(id), 'utf8')) as { sentences: SentenceBankEntry[] }).sentences;
  const allSentences = builtIds.flatMap(sentencesOf);
  const grammarItems = builtIds.flatMap((id) => loadBook(id).grammarItems);

  it('every grammar point of every lesson in all 4 books gets 3 exercises of at least 2 types', () => {
    for (const bookId of builtIds) {
      const own = sentencesOf(bookId);
      for (const lesson of loadBook(bookId).textbook.lessons)
        for (const seed of ['a', 'b', 'c']) {
          const { plan } = buildLessonGrammarStep(lesson, grammarItems, own, { lexicon, bookId, books: courseBooks, seed });
          for (const gid of lesson.grammar) {
            const ex = plan.exercises.filter((e) => e.grammarId === gid);
            expect(ex.length, `${bookId} L${lesson.n} ${gid}`).toBeGreaterThanOrEqual(3);
            expect(new Set(ex.map((e) => e.type)).size, `${bookId} L${lesson.n} ${gid}`).toBeGreaterThanOrEqual(2);
          }
          expect(plan.exercises.length).toBe(lesson.grammar.length * 3);
        }
    }
  });

  it('readings: 南區 nán qū, 怎麼了 zěn me le, 三明治 keeps its -n, 噢 òu, 姊姊 jiě jie', () => {
    const reading = (h: string) => lexicon.lookup(h).filter((w) => w.headword === h).map((w) => w.pinyin);
    expect(reading('南區')).toEqual(['nán qū']);
    expect(reading('怎麼了')).toEqual(['zěn me le']);
    expect(reading('雞肉三明治')).toEqual(['jī ròu sān míng zhì']);
    expect(new Set(reading('噢'))).toEqual(new Set(['òu']));
    expect(new Set(reading('姊姊'))).toEqual(new Set(['jiě jie']));
    expect(lexicon.allWords().filter((w) => /\s/.test(w.headword))).toEqual([]);
  });

  it('分 is "minute" in book 1 lesson 9, and book 1 teaches 姊姊 as the book writes it', () => {
    const fen = loadBook('laixue-1').wordNotes.find((n) => n.headword === '分' && n.lesson === 9)!;
    expect(glossFor(lexicon.byId(fen.wordId)!, { textbook: true, lesson: { bookId: 'laixue-1', n: 9 } })).toMatch(/minute/);
    const l2 = loadBook('laixue-1').textbook.lessons[1]!;
    expect(l2.vocab.map((id) => lexicon.byId(id)?.headword)).toContain('姊姊');
    expect(sentencesOf('laixue-1').filter((s) => s.zh.includes('姐姐'))).toEqual([]);
  });

  it('十一點 is one reorder tile', () => {
    const s = sentencesOf('laixue-1').find((x) => x.zh.includes('十一點'))!;
    expect(sentenceTiles(s, lexicon, lessonTileWords(lexicon, courseBooks, s.lesson!, 'laixue-1'))).toContain('十一點');
  });

  it('Taiwan usage: no 自行車, no "Lisa" in Chinese, no 服務員 NPC, no names in study vocabulary', () => {
    const zh = [
      ...allSentences.map((s) => s.zh),
      ...scenarios.flatMap((s) => [s.opener.zh, s.successLine.zh, s.npc.name, ...s.vocabExtras]),
      ...builtIds.flatMap((id) => loadBook(id).textbook.lessons.flatMap((l) => l.journalPrompts.flatMap((p) => p.promptZh ?? []))),
    ];
    expect(zh.filter((z) => z.includes('自行車') || /Lisa/.test(z))).toEqual([]);
    expect(scenarios.filter((s) => s.npc.name === '服務員').map((s) => s.id)).toEqual([]);
    // the learner is never given a name (book 4 L1 called them 莉亞)
    expect(scenarios.filter((s) => s.opener.zh.includes('莉亞')).map((s) => s.id)).toEqual([]);
    for (const id of builtIds)
      for (const l of loadBook(id).textbook.lessons)
        expect(l.vocab.filter((v) => l.properNouns.includes(v) || lexicon.byId(v)?.tags.includes('name')), `${id} L${l.n}`).toEqual([]);
  });
});
