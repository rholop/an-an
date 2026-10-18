// Phase 46: grammar exercises that never give the answer away, and that every grammar point can have.
//
// Part A: before an answer a card shows the pattern masked (`maskPattern`) and a short English
// meaning (`grammarMeaningHint`); the full pattern and explanation come after.
// Part B: one exercise source order for the lesson, tutoring and Review cards
// (`grammarPracticeTiers`): the point's textbook sentences, then the class's own sentences, then the
// sentence banks (supplement sentences, any textbook sentence, other classes, stories) that use the
// point with at most one unknown word. `buildPointExercise` builds from the first tier that works.
import { isUsableSentence } from '../cloze/report.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import type { Lexicon } from '../lexicon.js';
import { levelIndex } from '../levels.config.js';
import { isAlwaysAllowedWord } from '../progress/terms.js';
import { segment } from '../segment.js';
import { seededRng } from '../session/orderSession.js';
import type { GrammarItem } from '../types.js';
import { courseOrdinal, LAIXUE_COURSE } from './course.js';
import {
  buildGrammarStep,
  patternBlank,
  type GrammarSentence,
  type GrammarStepExercise,
  type GrammarStepInputs,
} from './grammar-step.js';
import { lessonTileWords } from './lesson-grammar-step.js';
import { homeLessonOfTags } from './scope.js';
import type { Textbook } from './types.js';

// ---------------------------------------------------------------------------------------------
// Part A: masking

/** What stands in for a hidden part of a pattern. */
export const PATTERN_BLANK = '＿＿';

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;

/**
 * Every Chinese part of `text` that is one of the `choices` or is in the `answer` becomes ＿＿; an
 * answer inside a longer part is masked there too (還 in 還沒 → ＿＿沒). Neighbouring hidden
 * characters become one ＿＿.
 */
export function maskChinese(text: string, answer: string | readonly string[], choices: readonly string[]): string {
  const answers = (typeof answer === 'string' ? [answer] : [...answer]).filter((a) => HAN.test(a));
  const whole = new Set(choices.filter((c) => HAN.test(c)));
  const inner = [...new Set(answers)].sort((a, b) => b.length - a.length);
  return text.replace(HAN_RUN, (run) => {
    if (whole.has(run) || answers.some((a) => a.includes(run))) return PATTERN_BLANK;
    const chars = [...run];
    const hidden = chars.map(() => false);
    for (const a of inner) {
      const ac = [...a];
      for (let i = 0; i + ac.length <= chars.length; i++)
        if (ac.every((c, k) => chars[i + k] === c)) for (let k = 0; k < ac.length; k++) hidden[i + k] = true;
    }
    let out = '';
    chars.forEach((c, i) => {
      if (!hidden[i]) out += c;
      else if (i === 0 || !hidden[i - 1]) out += PATTERN_BLANK;
    });
    return out;
  });
}

/**
 * Part A.3: the pattern as a card shows it before the answer: every Chinese part that is a choice or
 * in the answer is ＿＿ ("S + ＿＿ + someone + 一起 + V (O)"). Undefined when nothing useful is left
 * (only blanks and punctuation): the card then hides the pattern until after the answer.
 */
export function maskPattern(pattern: string, answer: string | readonly string[], choices: readonly string[]): string | undefined {
  const masked = maskChinese(pattern, answer, choices);
  return /\p{L}/u.test(masked.split(PATTERN_BLANK).join('')) ? masked : undefined;
}

/** What an exercise's answer and choices are, for masking (a whole sentence for tiles and Pick). */
export function exerciseMaskTerms(ex: GrammarStepExercise): { answer: string[]; choices: string[] } {
  switch (ex.type) {
    case 'fill':
      return { answer: [ex.answer], choices: ex.options };
    case 'pick':
      return { answer: [ex.zh], choices: [...ex.options] };
    default:
      return { answer: ex.accepted, choices: ex.tiles };
  }
}

/** `maskPattern` for an exercise's own answer and choices. */
export const maskPatternFor = (pattern: string, ex: GrammarStepExercise): string | undefined => {
  const { answer, choices } = exerciseMaskTerms(ex);
  return maskPattern(pattern, answer, choices);
};

/**
 * Part A.1: the English meaning shown before the answer: the explanation's first sentence without
 * its Chinese example, masked like the pattern ("＿＿…一起 means "together with…" and goes before the
 * main verb."). Undefined when that leaves no real English.
 */
export function grammarMeaningHint(explanationEn: string, ex: GrammarStepExercise): string | undefined {
  const first = explanationEn.trim().split(/(?<=[.!?])\s+(?=[A-Z"“‘\p{Script=Han}])/u)[0] ?? '';
  // "…before the main verb: 我跟朋友一起吃飯." → "…before the main verb."
  const noExample = first.replace(/[:：]\s*[^:：]*\p{Script=Han}[^:：]*$/u, '').trim();
  const { answer, choices } = exerciseMaskTerms(ex);
  const masked = maskChinese(noExample, answer, choices).replace(/[.。]?$/, '.');
  return (masked.match(/[A-Za-z]{2,}/g) ?? []).length >= 3 ? masked : undefined;
}

// ---------------------------------------------------------------------------------------------
// Part B: where a point's exercises come from

/** Does a sentence use the point (its marker inside the pattern's span; else its matcher)? */
export function sentenceFitsGrammar(
  zh: string,
  item: Pick<GrammarItem, 'focus' | 'matcher'>,
  lexicon?: Lexicon,
): boolean {
  if ((item.focus ?? []).length > 0) return patternBlank(zh, item, lexicon) !== undefined;
  if (!item.matcher) return false;
  try {
    return new RegExp(item.matcher, 'u').test(zh);
  } catch {
    return false;
  }
}

/** Words of `zh` the learner can't read yet (names, particles and numbers never count). */
export function unknownWordsOf(zh: string, lexicon: Lexicon, known: (wordId: string) => boolean): string[] {
  const out = new Set<string>();
  for (const tok of segment(zh, lexicon)) {
    if (tok.kind === 'unknown') out.add(tok.text);
    if (tok.kind !== 'word') continue;
    const ws = lexicon.lookup(tok.text);
    if (!ws.some((w) => known(w.id) || isAlwaysAllowedWord(w.tags))) out.add(tok.text);
  }
  return [...out];
}

/** A sentence any source can give: an id, the sentence and (when there is one) its English. */
export interface PracticeSentence {
  id: string;
  zh: string;
  en: string;
}

export interface GrammarPracticeSources {
  /** Every textbook bank sentence (any book). */
  textbook: readonly SentenceBankEntry[];
  /** Source 2: the class's own sentences (its example first, then other kept sentences, then the
   * ones written for it at Save or by "Write practice"). */
  classSentences?: readonly PracticeSentence[];
  /** Source 3 beyond the textbook: other classes' kept sentences, story sentences. */
  bank?: readonly PracticeSentence[];
  /** The learner's comprehensible words (undefined = don't filter, e.g. the CI audit). */
  known?: (wordId: string) => boolean;
  /** Reported sentences never come back. */
  excluded?: ReadonlySet<string>;
}

/** At most this many words a bank sentence may have that the learner doesn't know (Part B.1.3). */
export const MAX_UNKNOWN_IN_BANK_SENTENCE = 1;
/** Fewer sentences than this from sources 1–3 → one model call writes some (Part B.1.4). */
export const MIN_PRACTICE_SENTENCES = 3;

const asSentence = (s: Pick<SentenceBankEntry, 'id' | 'zh' | 'en'> & Partial<SentenceBankEntry>, gid: string): GrammarSentence => ({
  id: s.id,
  zh: s.zh,
  en: s.en,
  grammarIds: [gid],
  ...(s.altOrders ? { altOrders: s.altOrders } : {}),
  ...(s.wrong ? { wrong: s.wrong } : {}),
  ...(s.tiles ? { tiles: s.tiles } : {}),
});

/**
 * Part B.1: a point's exercise sentences, in source order: [textbook sentences tagged with it (its
 * own book)], [the class's sentences using it], [the banks: hand-written supplement sentences, any
 * other textbook sentence, other classes and stories using it, with ≤ 1 unknown word]. Each
 * sentence appears once, in the first tier that has it.
 */
export function grammarPracticeTiers(
  item: GrammarItem,
  sources: GrammarPracticeSources,
  lexicon: Lexicon,
): GrammarSentence[][] {
  const seen = new Set<string>();
  const usable = (zh: string) => zh.trim() && isUsableSentence(zh, sources.excluded) && !seen.has(zh.trim());
  const take = <T extends { zh: string }>(list: readonly T[], ok: (s: T) => boolean): T[] =>
    list.filter((s) => {
      if (!usable(s.zh) || !ok(s)) return false;
      seen.add(s.zh.trim());
      return true;
    });
  const fits = (s: { zh: string }) => sentenceFitsGrammar(s.zh, item, lexicon);
  const readable = (s: { zh: string }) =>
    !sources.known || unknownWordsOf(s.zh, lexicon, sources.known).length <= MAX_UNKNOWN_IN_BANK_SENTENCE;

  const home = homeLessonOfTags(item.tags ?? []);
  const tagged = take(
    sources.textbook.filter((s) => s.grammarIds?.includes(item.id) && (!home || ((s.textbookId ?? 'laixue-1') === home.bookId && s.lesson === home.n))),
    () => true,
  );
  const fromClass = take(sources.classSentences ?? [], fits);
  const supplement = (item.practice ?? []).map((p, i) => ({ id: `${item.id}:practice:${i}`, zh: p.zh, en: p.en }));
  const bank = [
    ...take(supplement, fits),
    ...take(sources.textbook, (s) => fits(s) && readable(s)),
    ...take(sources.bank ?? [], (s) => fits(s) && readable(s)),
  ];
  return [tagged.map((s) => asSentence(s, item.id)), fromClass.map((s) => asSentence(s, item.id)), bank.map((s) => asSentence(s, item.id))];
}

/** How many exercise sentences sources 1–3 give a point (the CI audit, and "write some at Save?"). */
export function countPracticeSentences(item: GrammarItem, sources: GrammarPracticeSources, lexicon: Lexicon): number {
  return grammarPracticeTiers(item, sources, lexicon).reduce((n, t) => n + t.length, 0);
}

/**
 * Part B.2: distractors are the signal words of other points the learner has met by then: for a
 * textbook point, every point up to its home lesson (Phase 25); for a supplement point, every point
 * at or below its level. Never the point's own markers.
 */
export function grammarDistractorPool(item: GrammarItem, grammarItems: readonly GrammarItem[]): string[] {
  const home = homeLessonOfTags(item.tags ?? []);
  const own = new Set(item.focus ?? []);
  const lv = item.level ? levelIndex(item.level) : Infinity;
  const met = grammarItems.filter((g) => {
    if (g.id === item.id) return false;
    const gh = homeLessonOfTags(g.tags ?? []);
    if (home) return gh !== undefined && gh.ordinal <= home.ordinal;
    return g.level !== null && levelIndex(g.level) <= lv;
  });
  return [...new Set(met.flatMap((g) => g.focus ?? []))].filter((w) => !own.has(w));
}

/**
 * Part B: one exercise for one point (Review, Cloze, the tutoring step), from the first source tier
 * that gives one, with Phase 25's builders. Undefined = no practice yet for this point.
 */
export function buildPointExercise(
  grammarId: string,
  grammarItems: readonly GrammarItem[],
  sources: GrammarPracticeSources,
  opts: { lexicon: Lexicon; books?: readonly Textbook[]; seed: string },
): GrammarStepExercise | undefined {
  const item = grammarItems.find((g) => g.id === grammarId) ?? opts.lexicon.grammarItemById(grammarId);
  if (!item) return undefined;
  const home = homeLessonOfTags(item.tags ?? []);
  const tileWords =
    home && opts.books && opts.books.length > 0 && courseOrdinal(LAIXUE_COURSE, home.bookId, home.n) !== undefined
      ? lessonTileWords(opts.lexicon, opts.books, home.n, home.bookId)
      : {};
  const pool = grammarDistractorPool(item, grammarItems.some((g) => g.id === item.id) ? grammarItems : [...grammarItems, item]);
  const tiers = grammarPracticeTiers(item, sources, opts.lexicon);
  for (const [k, sentences] of tiers.entries()) {
    if (sentences.length === 0) continue;
    const inputs: GrammarStepInputs = {
      grammarIds: [item.id],
      grammarItems: [item],
      sentences,
      lexicon: opts.lexicon,
      pool,
      ...tileWords,
      rng: seededRng(`${opts.seed}:point:${k}`),
      perPoint: 1,
    };
    const ex = buildGrammarStep(inputs).exercises[0];
    if (ex) return ex;
  }
  return undefined;
}
