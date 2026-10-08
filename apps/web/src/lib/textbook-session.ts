import {
  buildGrammarCloze,
  courseOrdinal,
  homeLessonOfTags,
  isUsableSentence,
  seededRng,
  LAIXUE_COURSE,
  newSessionSeed,
  orderSession,
  type OrderedSession,
  type SessionCard,
  type GrammarClozeExercise,
  type GrammarItem,
  type Lesson,
  type SentenceBankEntry,
} from '@anan/core';

export type GrammarExercise =
  | ({ type: 'cloze' } & GrammarClozeExercise)
  | { type: 'reorder'; grammarId: string; sentenceId: string; zh: string; en?: string };

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * The grammar step of "Study this lesson": for each grammar point of the
 * lesson, a cloze on its signal word (or, for patterns without one, the book's
 * "put the words in order" exercise), drawn from this lesson's sentences. Every
 * point gets `perPoint` exercises; one in three of the rest becomes a reorder.
 */
export function buildGrammarExercises(
  lesson: Pick<Lesson, 'n' | 'grammar'>,
  grammarItems: readonly GrammarItem[],
  sentences: readonly SentenceBankEntry[],
  opts: {
    perPoint?: number;
    max?: number;
    rng?: () => number;
    bookId?: string;
    /** Phase 19: session id for the order; `recent` = keys shown at the end of the vocab step. */
    seed?: string;
    recent?: readonly (readonly string[])[];
    /** Phase 21: reported sentences (never offered again, in any sentence source). */
    excluded?: ReadonlySet<string>;
  } = {},
): OrderedSession<GrammarExercise> {
  // Phase 21: every random choice comes from the session seed, so a logged seed rebuilds it exactly.
  const seed = opts.seed ?? newSessionSeed('grammar');
  const rng = opts.rng ?? seededRng(`${seed}:grammar`);
  const perPoint = opts.perPoint ?? 2;
  const max = opts.max ?? 8;
  const byId = new Map(grammarItems.map((g) => [g.id, g]));
  const lessonSentences = sentences.filter((s) => s.lesson === lesson.n && isUsableSentence(s.zh, opts.excluded));
  // Distractors: the signal words of every point up to this lesson.
  const here = courseOrdinal(LAIXUE_COURSE, opts.bookId ?? 'laixue-1', lesson.n) ?? lesson.n;
  const pool = grammarItems
    .filter((g) => {
      const home = homeLessonOfTags(g.tags ?? []);
      return home !== undefined && home.ordinal <= here;
    })
    .flatMap((g) => g.focus ?? []);
  const out: GrammarExercise[] = [];
  for (const gid of lesson.grammar) {
    const g = byId.get(gid);
    if (!g) continue;
    const candidates = shuffle(
      lessonSentences.filter((s) => s.grammarIds?.includes(gid)),
      rng,
    );
    let made = 0;
    for (const s of candidates) {
      if (made >= perPoint) break;
      const cloze = buildGrammarCloze(s, g, pool, rng);
      if (cloze && (made === 0 || rng() > 0.34)) {
        out.push({ type: 'cloze', ...cloze });
        made++;
      } else if (!cloze || made > 0) {
        out.push({ type: 'reorder', grammarId: gid, sentenceId: s.id, zh: s.zh, en: s.en });
        made++;
      }
    }
  }
  // Phase 19: two exercises on one grammar point are siblings, so the shared order keeps them
  // apart (or leaves the second for next time); the gap also runs on from the vocab step.
  return orderSession(shuffle(out, rng).slice(0, max), describeGrammarExercise, {
    seed,
    recent: opts.recent,
  });
}

export function describeGrammarExercise(e: GrammarExercise): SessionCard {
  return { keys: [`grammar:${e.grammarId}`, ...(e.type === 'cloze' ? [`zh:${e.answer}`] : [])] };
}
