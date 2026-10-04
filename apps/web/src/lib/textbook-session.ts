import {
  buildGrammarCloze,
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
  opts: { perPoint?: number; max?: number; rng?: () => number } = {},
): GrammarExercise[] {
  const rng = opts.rng ?? Math.random;
  const perPoint = opts.perPoint ?? 2;
  const max = opts.max ?? 8;
  const byId = new Map(grammarItems.map((g) => [g.id, g]));
  const lessonSentences = sentences.filter((s) => s.lesson === lesson.n);
  // Distractors: the signal words of every point up to this lesson.
  const pool = grammarItems
    .filter((g) =>
      (g.tags ?? []).some(
        (t) => /:L(\d\d)$/.test(t) && Number(/:L(\d\d)$/.exec(t)![1]) <= lesson.n,
      ),
    )
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
  return shuffle(out, rng).slice(0, max);
}
