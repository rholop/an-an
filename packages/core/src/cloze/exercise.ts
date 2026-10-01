import { MAINLAND_TERMS } from '../data/mainland-terms.generated.js';
import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import type { Word } from '../types.js';
import { pickDistractors } from './distractors.js';
import type { ClozeSourceCandidate } from './source.js';

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface ClozeExercise {
  sentence: string;
  blankStart: number;
  blankEnd: number;
  answer: Word;
  sourceKind: ClozeSourceCandidate['sourceKind'];
  sourceLabel: string;
  en?: string;
}

/**
 * Locates `word`'s token within `source.zh` (re-segmenting, same approach
 * Phase 3's validator uses for hint alignment) and blanks it. Returns null
 * if the word can't actually be found as its own token in the sentence —
 * callers should fall back further (phase doc §2's "none" tier) rather than
 * blank a wrong span.
 */
export function buildClozeExercise(word: Word, source: ClozeSourceCandidate, lexicon: Lexicon): ClozeExercise | null {
  const tokens = segment(source.zh, lexicon);
  const match = tokens.find((t) => t.kind === 'word' && (t.text === word.headword || word.variants.includes(t.text)));
  if (!match) return null;
  return {
    sentence: source.zh,
    blankStart: match.start,
    blankEnd: match.end,
    answer: word,
    sourceKind: source.sourceKind,
    sourceLabel: source.sourceLabel,
    en: source.en,
  };
}

export interface ChoiceOption {
  word: Word;
  isCorrect: boolean;
}

function buildChoices(answer: Word, lexicon: Lexicon, count: number, preferConfusable: boolean, rng: () => number): ChoiceOption[] {
  const distractors = pickDistractors(answer, lexicon, { count: count - 1, preferConfusable }, rng);
  const options: ChoiceOption[] = [{ word: answer, isCorrect: true }, ...distractors.map((word) => ({ word, isCorrect: false }))];
  return shuffle(options, rng);
}

/** Rung 1 (phase doc §3): "choose from 4-6 chips incl. the answer" — 5 total,
 * distractors picked without confusable preference (anything same-level). */
export function buildWordBankOptions(answer: Word, lexicon: Lexicon, rng: () => number = Math.random): ChoiceOption[] {
  return buildChoices(answer, lexicon, 5, false, rng);
}

/** Rung 2: "multiple choice with confusable distractors" — 4 total. */
export function buildMultipleChoiceOptions(answer: Word, lexicon: Lexicon, rng: () => number = Math.random): ChoiceOption[] {
  return buildChoices(answer, lexicon, 4, true, rng);
}

export interface ReorderExercise {
  shuffled: string[];
  correctOrder: string[];
}

/** Phase 4 §5: sentence reordering — tokens shuffled, learner rebuilds. */
export function buildReorderExercise(sentence: string, lexicon: Lexicon, rng: () => number = Math.random): ReorderExercise {
  const tokens = segment(sentence, lexicon).map((t) => t.text);
  let shuffled = shuffle(tokens, rng);
  // A shuffle landing back on the original order isn't wrong, but it makes
  // for a trivial, useless exercise — reshuffle once if that happens (and
  // simply accept a reshuffle-into-itself for a 1-token sentence, where no
  // other order exists).
  if (tokens.length > 1 && shuffled.every((t, i) => t === tokens[i])) {
    shuffled = shuffle(tokens, rng);
  }
  return { shuffled, correctOrder: tokens };
}

export interface ProductionPrompt {
  en: string;
  accepted: string[];
}

/** Phase 4 §5: English -> Chinese production — typed, graded by exact/variant
 * match (see cloze/grading.ts's hanzi mode for the matching itself). */
export function buildProductionPrompt(word: Word): ProductionPrompt {
  return { en: word.glossEn, accepted: [word.headword, ...word.variants] };
}

export interface NaturalPairExercise {
  optionA: string;
  optionB: string;
  correctIndex: 0 | 1;
  note?: string;
}

function randomOrder(correct: string, incorrect: string, note: string | undefined, rng: () => number): NaturalPairExercise {
  return rng() < 0.5
    ? { optionA: correct, optionB: incorrect, correctIndex: 0, note }
    : { optionA: incorrect, optionB: correct, correctIndex: 1, note };
}

/** Phase 4 §5: "which sounds more natural?" — Taiwan vs. mainland phrasing,
 * reusing the same data checkTaiwanness() is built on. */
export function buildMainlandVsTaiwanExercise(rng: () => number = Math.random): NaturalPairExercise {
  const entry = MAINLAND_TERMS[Math.floor(rng() * MAINLAND_TERMS.length)]!;
  return randomOrder(entry.taiwan, entry.mainland[0]!, entry.note, rng);
}

/** A small curated set, not pipeline-generated — 了-placement is a fixed
 * grammar rule, not vocabulary data that grows with the lexicon. */
export const LE_PLACEMENT_EXAMPLES: { correct: string; incorrect: string; note: string }[] = [
  { correct: '我吃了晚餐。', incorrect: '我了吃晚餐。', note: '了 marks completion right after the verb, not before it.' },
  { correct: '他昨天去了台北。', incorrect: '他昨天了去台北。', note: '了 follows the verb it completes (去了), not the time phrase.' },
  { correct: '我看完了那本書。', incorrect: '我看了完那本書。', note: '了 goes after the full verb complement (看完), not inside it.' },
];

export function buildLePlacementExercise(rng: () => number = Math.random): NaturalPairExercise {
  const entry = LE_PLACEMENT_EXAMPLES[Math.floor(rng() * LE_PLACEMENT_EXAMPLES.length)]!;
  return randomOrder(entry.correct, entry.incorrect, entry.note, rng);
}
