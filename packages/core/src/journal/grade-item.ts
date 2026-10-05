import { gradeClozeAnswer, type ClozeInputMode, type GradeOptions } from '../cloze/grading.js';
import type { Lexicon } from '../lexicon.js';
import { normaliseAnswer } from './normalize.js';
import type { ErrorExercise, ErrorItem, ProviderName } from './types.js';
import { checkCorrectedRules, verifySentenceText, type JournalLLM } from './verifyCorrected.js';

/** What the learner did on a journal review card. */
export type ItemAnswer =
  | { kind: 'text'; text: string; mode?: ClozeInputMode }
  | { kind: 'choice'; option: string }
  | { kind: 'tap'; tokenIndex: number }
  | { kind: 'order'; tokens: string[] };

/** 'needs_check': the answer is not one we already accept, but a rewrite or a
 * different order might still be right: it takes one cached full-sentence check
 * ("I think mine is right too" / Fix my sentence). */
export type ItemGrade = 'correct' | 'correct_wrong_tone' | 'wrong' | 'needs_check';

const RANK: Record<ItemGrade, number> = {
  correct: 3,
  correct_wrong_tone: 2,
  needs_check: 1,
  wrong: 0,
};

/** Part D, local half: compare after normalising (Phase 4 rules: spaces and
 * punctuation ignored; pinyin/zhuyin input with tone-insensitive partial credit). */
export function gradeErrorItem(
  item: ErrorItem,
  answer: ItemAnswer,
  lexicon: Lexicon,
  options: GradeOptions = {},
): ItemGrade {
  const ex = item.exercise;
  if (!ex) return 'wrong';
  const accepted = ex.accepted.map(normaliseAnswer);
  switch (ex.kind) {
    case 'cloze': {
      if (answer.kind !== 'text' || !answer.text.trim()) return 'wrong';
      const mode = answer.mode ?? 'hanzi';
      if (mode === 'hanzi') return accepted.includes(normaliseAnswer(answer.text)) ? 'correct' : 'wrong';
      // pinyin / zhuyin: grade against the lexicon words the accepted answers are
      let best: ItemGrade = 'wrong';
      for (const a of ex.accepted)
        for (const w of lexicon.lookup(a)) {
          const g = gradeClozeAnswer(answer.text, w, mode, options);
          if (RANK[g] > RANK[best]) best = g;
        }
      return best;
    }
    case 'choice':
      return answer.kind === 'choice' && accepted.includes(normaliseAnswer(answer.option))
        ? 'correct'
        : 'wrong';
    case 'extra_word':
      return answer.kind === 'tap' &&
        (answer.tokenIndex === ex.extraTokenIndex || ex.acceptedTaps?.includes(answer.tokenIndex))
        ? 'correct'
        : 'wrong';
    case 'reorder': {
      if (answer.kind !== 'order') return 'wrong';
      return accepted.includes(normaliseAnswer(answer.tokens.join(''))) ? 'correct' : 'needs_check';
    }
    case 'fix': {
      if (answer.kind !== 'text' || !answer.text.trim()) return 'wrong';
      return accepted.includes(normaliseAnswer(answer.text)) ? 'correct' : 'needs_check';
    }
  }
}

/** The whole sentence the learner's answer makes. null when it can't be built. */
export function sentenceForAnswer(item: ErrorItem, answer: ItemAnswer): string | null {
  const ex = item.exercise;
  if (!ex) return null;
  switch (ex.kind) {
    case 'cloze':
    case 'choice': {
      const text = answer.kind === 'text' ? answer.text : answer.kind === 'choice' ? answer.option : '';
      if (!text.trim() || ex.blankStart === undefined || ex.blankEnd === undefined) return null;
      return item.corrected.slice(0, ex.blankStart) + text.trim() + item.corrected.slice(ex.blankEnd);
    }
    case 'extra_word': {
      if (answer.kind !== 'tap' || !ex.tokens) return null;
      return ex.tokens.filter((_, i) => i !== answer.tokenIndex).join('');
    }
    case 'reorder':
      return answer.kind === 'order' ? answer.tokens.join('') : null;
    case 'fix':
      return answer.kind === 'text' ? answer.text.trim() : null;
  }
}

/** The mistake the item is about is gone from the learner's sentence. */
export function mistakeGone(item: ErrorItem, attempt: string): boolean {
  const marks = item.marks?.original ?? [];
  return marks.every(([a, b]) => {
    const before = item.original.slice(a, b);
    if (before === '') return true; // an insertion: the full-sentence check decides
    const ctx = item.original.slice(Math.max(0, a - 3), a);
    return !attempt.includes(ctx + before);
  });
}

export interface ReconsiderDeps {
  lexicon: Lexicon;
  llm: Pick<JournalLLM, 'verifyJournalSentence'>;
  protectedTerms: readonly string[];
  avoidProvider?: ProviderName;
}

export type Reconsidered =
  | { accepted: true; item: ErrorItem }
  | { accepted: false; reason: string };

/** Adds the learner's answer to what the item accepts. */
export function withAcceptedAnswer(item: ErrorItem, answer: ItemAnswer): ErrorItem {
  const ex = item.exercise!;
  const next: ErrorExercise = { ...ex };
  if (ex.kind === 'extra_word' && answer.kind === 'tap')
    next.acceptedTaps = [...(ex.acceptedTaps ?? []), answer.tokenIndex];
  else {
    const sentence = ex.kind === 'cloze' || ex.kind === 'choice' ? undefined : sentenceForAnswer(item, answer);
    const value =
      ex.kind === 'cloze' || ex.kind === 'choice'
        ? answer.kind === 'text'
          ? answer.text.trim()
          : answer.kind === 'choice'
            ? answer.option
            : ''
        : sentence;
    if (value && !ex.accepted.some((a) => normaliseAnswer(a) === normaliseAnswer(value)))
      next.accepted = [...ex.accepted, value];
  }
  return { ...item, exercise: next };
}

/**
 * Part D: "I think mine is right too" — and the check behind a "Fix my
 * sentence" answer. One full-sentence check of what the learner's answer makes
 * (rules, then the independent checker, with the English meaning). For a fix
 * answer the specific mistake must also be gone. Accepted answers are added to
 * the item so the next review grades them instantly.
 */
export async function reconsiderAnswer(
  deps: ReconsiderDeps,
  item: ErrorItem,
  answer: ItemAnswer,
): Promise<Reconsidered> {
  const sentence = sentenceForAnswer(item, answer);
  if (!sentence) return { accepted: false, reason: 'There is nothing to check.' };
  if (item.exercise?.kind === 'fix' && !mistakeGone(item, sentence))
    return { accepted: false, reason: 'The mistake is still in your sentence.' };
  const rules = checkCorrectedRules(sentence, {
    lexicon: deps.lexicon,
    protectedTerms: deps.protectedTerms,
  });
  if (rules.length > 0) return { accepted: false, reason: rules.join('; ') };
  const res = await verifySentenceText(deps, sentence, {
    en: item.en,
    avoidProvider: deps.avoidProvider,
  });
  if (!res.ok) return { accepted: false, reason: res.problem };
  return { accepted: true, item: withAcceptedAnswer(item, answer) };
}

/** Reconcile a hand-edited corrected sentence for a Reported-page fix. */
export function patchExerciseSentence(item: ErrorItem, corrected: string): ErrorItem | null {
  const ex = item.exercise;
  if (!ex || (ex.kind !== 'cloze' && ex.kind !== 'choice') || !ex.answer) return null;
  const at = corrected.indexOf(ex.answer);
  if (at === -1 || corrected.indexOf(ex.answer, at + 1) !== -1) return null;
  const blank: [number, number] = [at, at + ex.answer.length];
  return {
    ...item,
    corrected,
    blank,
    exercise: { ...ex, blankStart: blank[0], blankEnd: blank[1] },
  };
}
