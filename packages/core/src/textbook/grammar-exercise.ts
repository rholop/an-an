import type { GrammarItem } from '../types.js';

export interface GrammarClozeExercise {
  grammarId: string;
  /** Sentence id (when it came from the bank). */
  sentenceId?: string;
  /** The sentence with the focus word replaced by `blank`. */
  before: string;
  after: string;
  answer: string;
  /** Answer + distractors, shuffled. */
  options: string[];
  en?: string;
  zh: string;
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * "Cloze on its grammar": blank the function word that signals the pattern
 * (都, 在, 的, 跟…一起's 跟) and offer it among other pattern words. Returns
 * undefined for patterns with no single signal word (A-not-A, numbers) — those
 * are practised with the reorder exercise instead.
 */
export function buildGrammarCloze(
  sentence: { id?: string; zh: string; en?: string },
  grammar: Pick<GrammarItem, 'id' | 'focus'>,
  /** Other pattern words to draw distractors from (any grammar item's `focus`). */
  distractorPool: readonly string[],
  rng: () => number = Math.random,
): GrammarClozeExercise | undefined {
  const focus = [...(grammar.focus ?? [])].sort((a, b) => b.length - a.length);
  let answer: string | undefined;
  let at = -1;
  for (const f of focus) {
    const i = sentence.zh.indexOf(f);
    if (i >= 0) {
      answer = f;
      at = i;
      break;
    }
  }
  if (!answer || at < 0) return undefined;
  const wrong = [...new Set(distractorPool)].filter(
    (w) => w !== answer && !sentence.zh.includes(w),
  );
  // Prefer distractors of a similar length so the options look alike.
  const ranked = shuffle(wrong, rng).sort(
    (a, b) =>
      Math.abs([...a].length - [...answer!].length) - Math.abs([...b].length - [...answer!].length),
  );
  const options = shuffle([answer, ...ranked.slice(0, 3)], rng);
  if (options.length < 3) return undefined;
  return {
    grammarId: grammar.id,
    sentenceId: sentence.id,
    before: sentence.zh.slice(0, at),
    after: sentence.zh.slice(at + answer.length),
    answer,
    options,
    en: sentence.en,
    zh: sentence.zh,
  };
}
