import { isUsableSentence } from '../cloze/report.js';
import type { Lexicon } from '../lexicon.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import { newSessionSeed, seededRng } from '../session/orderSession.js';
import type { GrammarItem } from '../types.js';
import { courseOrdinal, LAIXUE_COURSE } from './course.js';
import {
  buildGrammarStep,
  type GrammarSentence,
  type GrammarStepExercise,
  type GrammarStepInputs,
  type GrammarStepPlan,
  type TileWords,
} from './grammar-step.js';
import { derivedCompoundIds, homeLessonOfTags, lessonScopedWordIds } from './scope.js';
import type { Lesson, Textbook } from './types.js';

export interface LessonGrammarStep {
  plan: GrammarStepPlan;
  /** Kept for `extraExercise` (a miss comes back with another sentence). */
  inputs: GrammarStepInputs;
  seed: string;
}

/**
 * Phase 25: the grammar step of "Study this lesson". Every grammar point of the lesson gets
 * `perPoint` exercises (3), each on a different sentence of this lesson, round-robin (A B C A B C …),
 * with at least two exercise types per point. Nothing is deferred or dropped; reported sentences
 * never come back. Reorder tiles only use words of this lesson and the ones before it.
 */
export function buildLessonGrammarStep(
  lesson: Pick<Lesson, 'n' | 'grammar'>,
  grammarItems: readonly GrammarItem[],
  sentences: readonly SentenceBankEntry[],
  opts: {
    lexicon: Lexicon;
    bookId?: string;
    /** Every imported book (course order), for the words a tile may be. */
    books?: readonly Textbook[];
    seed?: string;
    excluded?: ReadonlySet<string>;
    perPoint?: number;
  },
): LessonGrammarStep {
  const seed = opts.seed ?? newSessionSeed('grammar');
  const bookId = opts.bookId ?? 'laixue-1';
  // Distractors: the signal words of every point up to this lesson.
  const here = courseOrdinal(LAIXUE_COURSE, bookId, lesson.n) ?? lesson.n;
  const pool = [
    ...new Set(
      grammarItems
        .filter((g) => {
          const home = homeLessonOfTags(g.tags ?? []);
          return home !== undefined && home.ordinal <= here;
        })
        .flatMap((g) => g.focus ?? []),
    ),
  ];
  const tileWords = opts.books && opts.books.length > 0 ? lessonTileWords(opts.lexicon, opts.books, lesson.n, bookId) : {};
  const lessonSentences: GrammarSentence[] = sentences
    .filter((s) => s.lesson === lesson.n && isUsableSentence(s.zh, opts.excluded))
    .map((s) => ({
      id: s.id,
      zh: s.zh,
      en: s.en,
      grammarIds: s.grammarIds,
      ...(s.altOrders ? { altOrders: s.altOrders } : {}),
      ...(s.wrong ? { wrong: s.wrong } : {}),
      ...(s.tiles ? { tiles: s.tiles } : {}),
    }));
  const inputs: GrammarStepInputs = {
    grammarIds: lesson.grammar,
    grammarItems,
    sentences: lessonSentences,
    lexicon: opts.lexicon,
    pool,
    ...tileWords,
    rng: seededRng(`${seed}:grammar`),
    ...(opts.perPoint ? { perPoint: opts.perPoint } : {}),
  };
  return { plan: buildGrammarStep(inputs), inputs, seed };
}

/**
 * Phase 25 B7: one exercise for one grammar point (Review and Cloze), from the same builder as the
 * lesson step: a sentence of the point's home lesson, never a reported one. Undefined when the point
 * has no textbook sentences.
 */
export function buildSingleGrammarExercise(
  grammarId: string,
  grammarItems: readonly GrammarItem[],
  sentences: readonly SentenceBankEntry[],
  opts: { lexicon: Lexicon; books?: readonly Textbook[]; seed: string; excluded?: ReadonlySet<string> },
): GrammarStepExercise | undefined {
  const g = grammarItems.find((x) => x.id === grammarId);
  const home = g ? homeLessonOfTags(g.tags ?? []) : undefined;
  if (!g || !home) return undefined;
  const own = sentences.filter((s) => (s.textbookId ?? 'laixue-1') === home.bookId);
  const { plan } = buildLessonGrammarStep({ n: home.n, grammar: [grammarId] }, grammarItems, own, {
    ...opts,
    bookId: home.bookId,
    perPoint: 1,
  });
  return plan.exercises[0];
}

/**
 * The words a reorder tile may be at a lesson: the course words up to it and the words readable from
 * them (我們 = 我 + 們), preferring the taught ones (每天/才, never 每/天才).
 */
export function lessonTileWords(
  lexicon: Lexicon,
  books: readonly Textbook[],
  n: number,
  bookId: string,
): Required<TileWords> {
  const scoped = lessonScopedWordIds(books, n, { bookId });
  const formsOf = (ids: Iterable<string>) =>
    new Set([...ids].flatMap((id) => {
      const w = lexicon.byId(id);
      return w ? [w.headword, ...w.variants] : [];
    }));
  const taught = formsOf(scoped);
  const readable = formsOf(derivedCompoundIds(lexicon, scoped));
  // A readable word that splits into taught words is shown as those words (吃/白飯, 回/家, 天/才):
  // only an everyday Novice word (沒有) or a word with a part never taught alone (我們, 這麼) stays one tile.
  const everyday = new Set(
    [...readable].filter((h) => lexicon.lookup(h).some((w) => w.level === 'N1' || w.level === 'N2')),
  );
  const splitsIntoTaught = (h: string): boolean => {
    const chars = [...h];
    const ok: boolean[] = [true];
    for (let i = 1; i <= chars.length; i++)
      ok[i] = Array.from({ length: i }, (_, j) => j).some((j) => ok[j] && i - j < chars.length && taught.has(chars.slice(j, i).join('')));
    return ok[chars.length]!;
  };
  return {
    allowed: (h) => taught.has(h) || everyday.has(h) || (readable.has(h) && !splitsIntoTaught(h)),
    taught: (h) => taught.has(h),
  };
}
