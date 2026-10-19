// Phase 49 Part C: the TOCFL test drill. Short Band A-style reading items built in code from text
// that people wrote or that was already checked (the lesson practice sentences and the sentence
// bank). No new AI: every question and every option comes from those sentences, the lexicon's
// senses and `core/confusables` (Phase 48: never the odd one out, fewer options rather than filler).
// Three item types:
// - gap: a 2–4 sentence passage with one test word blanked (選詞填空); options are look-alikes;
// - meaning: one sentence, pick its English; wrong options are the English of look-alike sentences
//   (they share the test word, or a grammar point, and mean something else);
// - context: one sentence with a word underlined, pick its meaning here; wrong options are the
//   meanings of the word's look-alikes.
// Every passage is ≥ 95% comprehensible-or-test words with at most 2 words above the target level,
// and passes the simplified / mainland check. Pure; the seed makes a round repeatable.

import { ALWAYS_ALLOWED_TAGS } from '../progress/terms.js';
import { TEST_PREP_CONFIG } from '../progress/test-prep.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import { oddOneOut, type ConfusableIndex } from '../confusables/index.js';
import { glossFor } from '../gloss/context.js';
import { hashText } from '../hash.js';
import type { Lexicon } from '../lexicon.js';
import { levelIndex, type Level } from '../levels.config.js';
import { segment, type Token } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import type { Evidence, Word } from '../types.js';
import type { Ledger } from '../progress/ledger.js';
import { practiceAnswerKind } from '../progress/practice.js';

export type DrillItemType = 'gap' | 'meaning' | 'context';
export const DRILL_ITEM_TYPES: readonly DrillItemType[] = ['gap', 'meaning', 'context'];

/** One piece of the passage as shown: plain text, the blank, or the underlined word. */
export interface DrillSpan {
  text: string;
  mark?: 'blank' | 'underline';
}

export interface DrillItem {
  id: string;
  type: DrillItemType;
  /** The test word the item is about (its answer counts for this word). */
  wordId: string;
  /** The passage, one array of spans per sentence. */
  passage: DrillSpan[][];
  options: string[];
  /** Index of the right option. */
  answer: number;
  /** Chinese options (gap) or English (meaning, context). */
  optionLang: 'zh' | 'en';
  /** The sentences used (a round never repeats one). */
  sentenceIds: string[];
}

export interface DrillInput {
  lexicon: Pick<Lexicon, 'byId' | 'lookup'>;
  /** Human-written or checked sentences (lesson practice sentences, the sentence bank). */
  sentences: readonly SentenceBankEntry[];
  /** Candidate test words, in the order to ask about them (the ledger's `drillWordIds()`, weakest first). */
  wordIds: readonly string[];
  /** Words the learner reads (the ledger's `comprehensible().ids`). */
  comprehensibleIds: ReadonlySet<string>;
  /** TOCFL words at or below the target. */
  testWordIds: ReadonlySet<string>;
  target: Level;
  index: ConfusableIndex;
  /** Plausible options first (known, in session, current level). */
  preferred?: ReadonlySet<string>;
  seed: string;
  /** Items per round (default `TEST_PREP_CONFIG.itemsPerRound`). */
  n?: number;
  /** Sentence ids to leave out (shown in the last rounds). */
  avoid?: ReadonlySet<string>;
}

interface Analysed {
  entry: SentenceBankEntry;
  tokens: Token[];
  /** Per token: the lexicon candidates' ids (word tokens only). */
  ids: string[][];
}

export interface PassageCheck {
  ok: boolean;
  coverage: number;
  aboveTarget: number;
  taiwanClean: boolean;
}

/** Phase 49 C.4: is this text fair for a drill? ≥ 95% comprehensible-or-test words, at most 2 words
 * above the target, traditional and Taiwan only. */
export function checkDrillPassage(
  text: string,
  input: Pick<DrillInput, 'lexicon' | 'comprehensibleIds' | 'testWordIds' | 'target'>,
): PassageCheck {
  return passageCheckOf([analyse(text, input.lexicon)], input);
}

function analyse(zh: string, lexicon: DrillInput['lexicon'], entry?: SentenceBankEntry): Analysed {
  const tokens = segment(zh, lexicon as Lexicon);
  const ids = tokens.map((t) => (t.kind === 'word' ? lexicon.lookup(t.text).map((w) => w.id) : []));
  return { entry: entry ?? ({ id: '', zh } as SentenceBankEntry), tokens, ids };
}

function passageCheckOf(parts: readonly Analysed[], input: Pick<DrillInput, 'lexicon' | 'comprehensibleIds' | 'testWordIds' | 'target'>): PassageCheck {
  let total = 0;
  let ok = 0;
  let above = 0;
  const cap = levelIndex(input.target);
  for (const p of parts)
    p.tokens.forEach((t, i) => {
      if (t.kind !== 'word' && t.kind !== 'unknown') return;
      total++;
      const ids = p.ids[i] ?? [];
      const words = ids.map((id) => input.lexicon.byId(id)).filter((w): w is Word => !!w);
      const fine =
        ids.some((id) => input.comprehensibleIds.has(id) || input.testWordIds.has(id)) ||
        words.some((w) => w.tags.some((tag) => ALWAYS_ALLOWED_TAGS.has(tag)));
      if (fine) {
        ok++;
        return;
      }
      const lowest = Math.min(...words.map((w) => (w.level ? levelIndex(w.level) : Infinity)));
      if (!(lowest <= cap)) above++;
    });
  const text = parts.map((p) => p.entry.zh).join('');
  const taiwanClean = checkTaiwanness(text).isClean;
  const coverage = total === 0 ? 1 : ok / total;
  return {
    ok: coverage >= TEST_PREP_CONFIG.passageCoverage && above <= TEST_PREP_CONFIG.passageMaxAboveTarget && taiwanClean,
    coverage,
    aboveTarget: above,
    taiwanClean,
  };
}

/** The lesson a textbook sentence was written for (its sense of a word), if any. */
function lessonOf(e: SentenceBankEntry): { bookId: string; n: number } | undefined {
  if (e.lesson === undefined) return undefined;
  const book = e.textbookId ?? e.tags?.find((t) => /^textbook:[^:]+$/.test(t))?.slice('textbook:'.length);
  return book ? { bookId: book, n: e.lesson } : undefined;
}

const lessonKey = (e: SentenceBankEntry): string | undefined => {
  const l = lessonOf(e);
  return l ? `${l.bookId}:${l.n}` : undefined;
};

const normEn = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const glossWords = (g: string) =>
  new Set(
    g
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^a-z']+/)
      .filter((t) => t.length > 2 && !['the', 'and', 'for', 'sth', 'one', 'someone', 'something'].includes(t)),
  );
/** Two meanings too alike to be a fair right / wrong pair. */
function glossesOverlap(a: string, b: string): boolean {
  if (normEn(a) === normEn(b)) return true;
  const wa = glossWords(a);
  const wb = glossWords(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared > 0 && shared * 2 >= Math.min(wa.size, wb.size);
}

/** A meaning as an option: without the book's cross-references ("(see grammar 2)"). */
const cleanGloss = (g: string) => g.replace(/\s*\(see [^)]*\)/gi, '').trim();

/** The first token of `a` that is `wordId` (or its headword). */
function tokenOf(a: Analysed, word: Word): number {
  return a.tokens.findIndex((t, i) => (a.ids[i] ?? []).includes(word.id) || (t.kind === 'word' && t.text === word.headword));
}

function marked(a: Analysed, at: number, mark: 'blank' | 'underline'): DrillSpan[] {
  const t = a.tokens[at]!;
  const zh = a.entry.zh;
  return [
    ...(t.start > 0 ? [{ text: zh.slice(0, t.start) }] : []),
    { text: mark === 'blank' ? '＿＿' : t.text, mark },
    ...(t.end < zh.length ? [{ text: zh.slice(t.end) }] : []),
  ];
}

/** Seeded order of options: the right one is never always first. */
function shuffled(options: string[], seed: string): { options: string[]; answer: number } {
  const keyed = options.map((o, i) => ({ o, i, k: parseInt(hashText(`${seed}|${o}`), 36) }));
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  return { options: keyed.map((x) => x.o), answer: keyed.findIndex((x) => x.i === 0) };
}

/**
 * One drill round: up to `n` items about the candidate words, the item types taking turns (a word
 * whose type can't be built fairly tries the next type, then the next word). Fewer items when the
 * sentences can't make more: never an unfair one.
 */
export function buildDrillRound(input: DrillInput): DrillItem[] {
  const n = input.n ?? TEST_PREP_CONFIG.itemsPerRound;
  const pool = input.sentences
    .filter((e) => !e.doubtful && !input.avoid?.has(e.id))
    .map((e) => analyse(e.zh, input.lexicon, e));
  // the passage rule, once per sentence
  const fair = pool.filter((a) => passageCheckOf([a], input).ok);
  const byWord = new Map<string, Analysed[]>();
  for (const a of fair)
    for (const ids of a.ids)
      for (const id of ids) {
        const list = byWord.get(id) ?? [];
        if (!list.includes(a)) list.push(a);
        byWord.set(id, list);
      }
  const byLesson = new Map<string, Analysed[]>();
  const byGrammar = new Map<string, Analysed[]>();
  for (const a of fair) {
    const k = lessonKey(a.entry);
    if (k) byLesson.set(k, [...(byLesson.get(k) ?? []), a]);
    for (const g of a.entry.grammarIds ?? []) byGrammar.set(g, [...(byGrammar.get(g) ?? []), a]);
  }

  const used = new Set<string>();
  const items: DrillItem[] = [];
  let turn = 0;
  for (const wordId of input.wordIds) {
    if (items.length >= n) break;
    const word = input.lexicon.byId(wordId);
    if (!word || !input.testWordIds.has(wordId)) continue;
    const sentences = (byWord.get(wordId) ?? []).filter((a) => !used.has(a.entry.id));
    if (sentences.length === 0) continue;
    const order = DRILL_ITEM_TYPES.map((_, i) => DRILL_ITEM_TYPES[(turn + i) % DRILL_ITEM_TYPES.length]!);
    for (const type of order) {
      const item =
        type === 'gap'
          ? gapItem(word, sentences, byLesson, used, input)
          : type === 'meaning'
            ? meaningItem(word, sentences, byWord, byGrammar, used, input)
            : contextItem(word, sentences, input);
      if (!item) continue;
      items.push(item);
      item.sentenceIds.forEach((id) => used.add(id));
      turn++;
      break;
    }
  }
  return items;
}

function gapItem(
  word: Word,
  sentences: readonly Analysed[],
  byLesson: ReadonlyMap<string, Analysed[]>,
  used: ReadonlySet<string>,
  input: DrillInput,
): DrillItem | undefined {
  const distractors = input.index.pick(word, {
    n: 3,
    mode: 'cloze',
    seed: `${input.seed}|gap`,
    levelCap: input.target,
    ...(input.preferred ? { preferred: input.preferred } : {}),
  });
  if (distractors.length < 2 || oddOneOut(word, distractors)) return undefined;
  const heads = new Set([word.headword, ...distractors.map((d) => d.headword)]);
  for (const a of sentences) {
    const at = tokenOf(a, word);
    if (at < 0) continue;
    // the rest of the sentence must not show the answer or an option (他們 beside a blanked 們)
    const rest = marked(a, at, 'blank').filter((x) => !x.mark).map((x) => x.text).join('');
    if ([...heads].some((h) => rest.includes(h))) continue;
    // up to two neighbours from the same lesson (in file order) that don't show the answer or an option
    const k = lessonKey(a.entry);
    const lesson = k ? (byLesson.get(k) ?? []) : [];
    const i = lesson.indexOf(a);
    const near = [lesson[i - 1], lesson[i + 1], lesson[i + 2]]
      .filter((x): x is Analysed => !!x && !used.has(x.entry.id) && x !== a)
      .filter((x) => ![...heads].some((h) => x.entry.zh.includes(h)))
      .slice(0, 2);
    const before = near.filter((x) => lesson.indexOf(x) < i);
    const after = near.filter((x) => lesson.indexOf(x) > i);
    const parts = [...before, a, ...after];
    if (!passageCheckOf(parts, input).ok) continue;
    const { options, answer } = shuffled([word.headword, ...distractors.map((d) => d.headword)], `${input.seed}|${a.entry.id}`);
    return {
      id: `gap:${word.id}:${a.entry.id}`,
      type: 'gap',
      wordId: word.id,
      passage: parts.map((p) => (p === a ? marked(a, at, 'blank') : [{ text: p.entry.zh }])),
      options,
      answer,
      optionLang: 'zh',
      sentenceIds: parts.map((p) => p.entry.id),
    };
  }
  return undefined;
}

function meaningItem(
  word: Word,
  sentences: readonly Analysed[],
  byWord: ReadonlyMap<string, Analysed[]>,
  byGrammar: ReadonlyMap<string, Analysed[]>,
  used: ReadonlySet<string>,
  input: DrillInput,
): DrillItem | undefined {
  for (const a of sentences) {
    if (!a.entry.en) continue;
    // look-alike sentences: they share this word or a grammar point, and mean something else
    const others = [...(byWord.get(word.id) ?? []), ...(a.entry.grammarIds ?? []).flatMap((g) => byGrammar.get(g) ?? [])];
    const wrong: Analysed[] = [];
    const seen = new Set([normEn(a.entry.en)]);
    for (const o of others) {
      if (wrong.length >= 3) break;
      if (o === a || used.has(o.entry.id) || !o.entry.en || o.entry.zh === a.entry.zh) continue;
      const en = normEn(o.entry.en);
      if (seen.has(en)) continue;
      if (oddOneOut(a.entry.zh, [...wrong.map((w) => w.entry.zh), o.entry.zh])) continue;
      seen.add(en);
      wrong.push(o);
    }
    if (wrong.length < 2) continue;
    const { options, answer } = shuffled([a.entry.en, ...wrong.map((w) => w.entry.en)], `${input.seed}|${a.entry.id}`);
    return {
      id: `meaning:${word.id}:${a.entry.id}`,
      type: 'meaning',
      wordId: word.id,
      passage: [[{ text: a.entry.zh }]],
      options,
      answer,
      optionLang: 'en',
      sentenceIds: [a.entry.id],
    };
  }
  return undefined;
}

function contextItem(word: Word, sentences: readonly Analysed[], input: DrillInput): DrillItem | undefined {
  const looks = input.index.pick(word, {
    n: 5,
    mode: 'any',
    seed: `${input.seed}|ctx`,
    levelCap: input.target,
    ...(input.preferred ? { preferred: input.preferred } : {}),
  });
  for (const a of sentences) {
    const at = tokenOf(a, word);
    if (at < 0) continue;
    const lesson = lessonOf(a.entry);
    const right = cleanGloss(glossFor(word, lesson ? { lesson } : {}));
    const wrongWords: Word[] = [];
    const glosses = [right];
    for (const w of looks) {
      if (wrongWords.length >= 3) break;
      const g = cleanGloss(glossFor(w));
      if (glosses.some((x) => glossesOverlap(x, g))) continue;
      if (oddOneOut(word, [...wrongWords, w])) continue;
      wrongWords.push(w);
      glosses.push(g);
    }
    if (wrongWords.length < 2) return undefined;
    const { options, answer } = shuffled(glosses, `${input.seed}|${a.entry.id}`);
    return {
      id: `context:${word.id}:${a.entry.id}`,
      type: 'context',
      wordId: word.id,
      passage: [marked(a, at, 'underline')],
      options,
      answer,
      optionLang: 'en',
      sentenceIds: [a.entry.id],
    };
  }
  return undefined;
}

export interface DrillScore {
  right: number;
  inTime: number;
  total: number;
}

/** "4 / 5 right · 3 within time": running out of time is "slow", never wrong. */
export function drillScore(answers: ReadonlyArray<{ correct: boolean; seconds: number }>, secondsPerItem: number = TEST_PREP_CONFIG.secondsPerItem): DrillScore {
  return {
    right: answers.filter((a) => a.correct).length,
    inTime: answers.filter((a) => a.seconds <= secondsPerItem).length,
    total: answers.length,
  };
}

/**
 * Phase 49 C.5: what one drill answer records, counted like Phase 45 practice. The word's Meaning card
 * (only when it has been answered before: a drill never adds a word or a face) gets the day's first
 * answer as a `review_*` with `context.practice` (right = Good, wrong = Again); later answers that day
 * are `practice_*`. Practice answers never start, fix or finish a session. Every item also stores
 * `drill_correct` / `drill_wrong` for reading accuracy.
 */
export function drillAnswerEvidence(
  ledger: Pick<Ledger, 'practiceCards' | 'practiceCounts'>,
  item: Pick<DrillItem, 'wordId' | 'id'>,
  correct: boolean,
  at: Date,
  sessionKey?: string,
): Evidence[] {
  const ref = { kind: 'word' as const, id: item.wordId };
  const out: Evidence[] = [];
  const card = ledger.practiceCards([ref]).find((c) => c.skill === 'recognition');
  if (card)
    out.push({
      item: ref,
      skill: 'recognition',
      kind: practiceAnswerKind(correct ? 'good' : 'again', ledger.practiceCounts(card)),
      at,
      context: { source: 'drill', practice: true, face: 'meaning', refId: item.id, ...(sessionKey ? { sessionKey } : {}) },
    });
  out.push({ item: ref, skill: 'recognition', kind: correct ? 'drill_correct' : 'drill_wrong', at, context: { source: 'drill', refId: item.id } });
  return out;
}
