/**
 * Phase 12 acceptance checks over the BUILT curriculum data (data/curriculum/laixue-1,
 * data/build/lexicon, scenarios, sentences). Skipped when the data isn't built.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkTaiwanness,
  Lexicon,
  lessonTag,
  textbookTag,
  type GrammarItem,
  type SentenceBankEntry,
  type Scenario,
  type TextbookFile,
  type Word,
} from '@anan/core';
import { makeScopeChecker } from './lib/curriculum/scope-check.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BOOK = path.join(REPO, 'data/curriculum/laixue-1/book.json');
const LEX = path.join(REPO, 'data/build/lexicon.v2.json');
const SENT = path.join(REPO, 'data/build/sentences.textbook-laixue-1.json');
const SCEN = path.join(REPO, 'data/build/scenarios.json');
const built = [BOOK, LEX, SENT, SCEN].every(existsSync);

interface Book extends TextbookFile {
  grammarItems: GrammarItem[];
  wordNotes: Array<{ wordId: string; lesson: number; headword: string }>;
}

describe.skipIf(!built)('built textbook data (laixue-1)', () => {
  const book = built ? (JSON.parse(readFileSync(BOOK, 'utf8')) as Book) : (undefined as never);
  const lexRaw = built
    ? (JSON.parse(readFileSync(LEX, 'utf8')) as { words: Word[]; grammar: GrammarItem[] })
    : (undefined as never);
  const lexicon = built ? new Lexicon(lexRaw.words, lexRaw.grammar) : (undefined as never);
  const sentences = built
    ? (JSON.parse(readFileSync(SENT, 'utf8')).sentences as SentenceBankEntry[])
    : [];
  const scenarios = built ? (JSON.parse(readFileSync(SCEN, 'utf8')).scenarios as Scenario[]) : [];
  const lessons = built ? book.textbook.lessons : [];

  it('has 10 lessons and exactly 34 grammar points, each a schedulable lexicon item with both tags', () => {
    expect(lessons).toHaveLength(10);
    expect(book.grammarItems).toHaveLength(34);
    expect(lessons.flatMap((l) => l.grammar)).toHaveLength(34);
    for (const g of book.grammarItems) {
      const inLexicon = lexicon.grammarItemById(g.id);
      expect(inLexicon, g.id).toBeDefined();
      expect(inLexicon!.tags).toContain(textbookTag());
      expect(inLexicon!.tags!.some((t) => /^textbook:laixue-1:L\d\d$/.test(t))).toBe(true);
    }
  });

  it('every book word resolves to a lexicon entry carrying both textbook tags and the book sense', () => {
    expect(book.wordNotes.length).toBeGreaterThanOrEqual(223);
    for (const n of book.wordNotes) {
      const w = lexicon.byId(n.wordId);
      expect(w, `${n.headword} (${n.wordId})`).toBeDefined();
      expect(w!.tags, n.headword).toContain(textbookTag());
      expect(w!.tags, n.headword).toContain(lessonTag(n.lesson));
    }
  });

  it('book words that are also TOCFL keep both (source stays tocfl, tags added)', () => {
    const tocflAndBook = lexRaw.words.filter(
      (w) => w.source === 'tocfl' && w.tags.includes(textbookTag()),
    );
    expect(tocflAndBook.length).toBeGreaterThan(80);
    const neu = lexRaw.words.filter((w) => w.source === 'textbook');
    expect(neu.length).toBeGreaterThan(20);
    expect(neu.every((w) => w.level === 'N1')).toBe(true);
  });

  it('each lesson has ≥1 scenario, ≥20 validated sentences and 3 journal prompts (3 words + 1 grammar)', () => {
    for (const l of lessons) {
      expect(l.scenarios.length, `L${l.n} scenarios`).toBeGreaterThanOrEqual(1);
      for (const id of l.scenarios) {
        const sc = scenarios.find((s) => s.id === id);
        expect(sc, id).toBeDefined();
        expect(sc!.textbook).toEqual({ textbookId: 'laixue-1', lesson: l.n });
      }
      expect(
        sentences.filter((s) => s.lesson === l.n).length,
        `L${l.n} sentences`,
      ).toBeGreaterThanOrEqual(20);
      expect(l.journalPrompts, `L${l.n} prompts`).toHaveLength(3);
      for (const p of l.journalPrompts) {
        expect(p.useWords).toHaveLength(3);
        expect(p.useGrammar).toHaveLength(1);
        expect(l.grammar).toContain(p.useGrammar[0]);
      }
    }
  });

  it('every sentence passes the lesson-scoped validator, is Taiwan-clean, tagged, and exercises a lesson grammar point', () => {
    for (const l of lessons) {
      const scope = makeScopeChecker(lexicon, book.textbook, l.n);
      for (const s of sentences.filter((x) => x.lesson === l.n)) {
        const r = scope.check(s.zh);
        expect(r.pass, `L${l.n} ${s.zh} → ${r.unknown.map((u) => u.token.text).join('、')}`).toBe(
          true,
        );
        expect(checkTaiwanness(s.zh).isClean, s.zh).toBe(true);
        expect(s.tags).toEqual([textbookTag(), lessonTag(l.n)]);
        expect(s.grammarIds!.length).toBeGreaterThan(0);
      }
      const lessonGrammarCovered = new Set(
        sentences.filter((x) => x.lesson === l.n).flatMap((x) => x.grammarIds ?? []),
      );
      for (const g of l.grammar) expect(lessonGrammarCovered.has(g), `L${l.n} ${g}`).toBe(true);
    }
  });

  it('scenario lines meet the validator with the lesson-scoped vocabulary (and nothing from later lessons)', () => {
    for (const l of lessons) {
      const scope = makeScopeChecker(lexicon, book.textbook, l.n);
      for (const id of l.scenarios) {
        const sc = scenarios.find((s) => s.id === id)!;
        for (const zh of [sc.opener.zh, sc.successLine.zh]) {
          const r = scope.check(zh);
          expect(r.pass, `${id}: ${zh} → ${r.unknown.map((u) => u.token.text).join('、')}`).toBe(
            true,
          );
        }
      }
    }
    // A lesson-2 scope rejects a lesson-9 sentence.
    const l2 = makeScopeChecker(lexicon, book.textbook, 2);
    expect(l2.check('我星期五晚上六點半在餐廳見。').pass).toBe(false);
  });

  it('keeps lesson content scoped: scenario vocabExtras are words of lessons ≤ the scenario lesson', () => {
    for (const l of lessons) {
      const scope = makeScopeChecker(lexicon, book.textbook, l.n);
      for (const id of l.scenarios) {
        const sc = scenarios.find((s) => s.id === id)!;
        for (const h of sc.vocabExtras) {
          expect(
            lexicon.lookup(h).some((w) => scope.readable.has(w.id)),
            `${id}: ${h}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('textbook copyright handling', () => {
  it('the PDF and the extracted book text are gitignored and not tracked', () => {
    // Ask git itself, so the exact .gitignore pattern (a glob or a literal path) doesn't matter.
    for (const p of [
      'data/raw/textbook/laixue-1.pdf',
      'data/curriculum/laixue-1/private/dialogues.json',
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
    let tracked = '';
    try {
      tracked = execFileSync(
        'git',
        ['ls-files', 'data/raw/textbook', 'data/curriculum/laixue-1/private'],
        {
          cwd: REPO,
          encoding: 'utf8',
        },
      );
    } catch {
      return; // not a git checkout (e.g. a source tarball) — nothing tracked by definition
    }
    expect(tracked.trim()).toBe('');
  });

  it('book.json (safe to commit) contains no dialogue or example text', () => {
    if (!existsSync(BOOK)) return;
    const raw = readFileSync(BOOK, 'utf8');
    const priv = path.join(REPO, 'data/curriculum/laixue-1/private/dialogues.json');
    if (!existsSync(priv)) return;
    const dialogues = JSON.parse(readFileSync(priv, 'utf8')) as Record<
      string,
      { lines: Array<{ zh: string }> }
    >;
    for (const d of Object.values(dialogues)) {
      for (const line of d.lines) {
        if ([...line.zh].length >= 8) expect(raw.includes(line.zh), line.zh).toBe(false);
      }
    }
  });

  it("none of the app's public lesson content copies the book's own dialogue or example sentences", () => {
    const dlg = path.join(REPO, 'data/curriculum/laixue-1/private/dialogues.json');
    const exs = path.join(REPO, 'data/curriculum/laixue-1/private/examples.json');
    if (!built || !existsSync(dlg) || !existsSync(exs)) return;
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
    const book = JSON.parse(readFileSync(BOOK, 'utf8')) as Book;
    const ours: string[] = [
      ...(JSON.parse(readFileSync(SENT, 'utf8')).sentences as SentenceBankEntry[]).map((x) => x.zh),
      ...(JSON.parse(readFileSync(SCEN, 'utf8')).scenarios as Scenario[])
        .filter((s) => s.textbook)
        .flatMap((s) => [s.opener.zh, s.successLine.zh]),
      ...book.textbook.lessons.flatMap((l) =>
        l.journalPrompts.flatMap((p) => (p.promptZh ? [p.promptZh] : [])),
      ),
    ];
    expect(ours.filter((z) => bookText.has(z))).toEqual([]);
  });
});
