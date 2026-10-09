import {
  buildGrammarStep,
  courseOrdinal,
  homeLessonOfTags,
  isUsableSentence,
  lessonScopedWordIds,
  seededRng,
  LAIXUE_COURSE,
  newSessionSeed,
  type GrammarItem,
  type GrammarSentence,
  type GrammarStepExercise,
  type GrammarStepInputs,
  type GrammarStepPlan,
  type Lesson,
  type Lexicon,
  type SentenceBankEntry,
  type Textbook,
} from '@anan/core';

export type GrammarExercise = GrammarStepExercise;

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
  let allowed: ((h: string) => boolean) | undefined;
  if (opts.books && opts.books.length > 0) {
    const heads = new Set(
      [...lessonScopedWordIds(opts.books, lesson.n, { bookId })].flatMap((id) => opts.lexicon.byId(id)?.headword ?? []),
    );
    allowed = (h) => heads.has(h);
  }
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
    ...(allowed ? { allowed } : {}),
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
