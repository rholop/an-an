import { emptyCard } from '../learner/fsrs-instance.js';
import type { SkillCard } from '../learner/types.js';
import { practiceStrengthOf } from '../progress/terms.js';
import type { Lexicon } from '../lexicon.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import { levelIndex, type Level } from '../levels.config.js';
import type { Word } from '../types.js';
import { orderSession, seededRng, type OrderedSession, type SessionCard } from '../session/orderSession.js';
import { unlocksListening } from '../progress/terms.js';
import { LISTENING_CONFIG, type ExerciseType, type ListeningConfig } from './config.js';
import type { ClipLookup } from './clips.js';
import { toneDigit } from '../journal/normalize.js';
import { toneCheckEligible, toneless, tonePattern, wordTones } from './tones.js';

export interface HearPick {
  type: 'hear_pick';
  wordId: string;
  options: string[];
  answer: string;
}
export interface HearType {
  type: 'hear_type';
  wordId: string;
  headword: string;
}
export interface ToneCheck {
  type: 'tone_check';
  wordId: string;
  options: string[];
  answer: string;
}
export interface TonePair {
  type: 'tone_pair';
  /** The two words of the minimal pair; `play` says which one the clip is. */
  a: string;
  b: string;
  play: 'a' | 'b';
}
export interface SentenceDictation {
  type: 'sentence_dictation';
  sentenceId: string;
  zh: string;
}
export interface ListenUnderstand {
  type: 'listen_understand';
  sentenceId: string;
  zh: string;
  options: string[];
  answer: string;
}
export type Exercise = HearPick | HearType | ToneCheck | TonePair | SentenceDictation | ListenUnderstand;

const shuffle = <T,>(arr: readonly T[], rng: () => number): T[] => {
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [c[i], c[j]] = [c[j]!, c[i]!];
  }
  return c;
};

const key = (w: Pick<Word, 'pinyinNumeric'>) => toneless(w).join(' ');

/**
 * Distractors that SOUND alike: the same syllables with different tones first (買/賣, 湯/糖),
 * then words sharing a syllable (老師/老實). Falls back to same-length words so the
 * exercise still works when the lexicon is sparse around a word.
 */
export function soundAlikeDistractors(
  word: Word,
  pool: readonly Word[],
  n: number,
  rng: () => number = Math.random,
): Word[] {
  const myKey = key(word);
  const syl = toneless(word);
  const shown = (w: Word) => w.headword;
  const used = new Set<string>([word.headword]);
  const out: Word[] = [];
  const take = (cands: Word[]) => {
    for (const w of shuffle(cands, rng)) {
      if (out.length >= n) return;
      if (used.has(shown(w))) continue;
      used.add(shown(w));
      out.push(w);
    }
  };
  const real = pool.filter((w) => w.id !== word.id && w.pinyinNumeric && [...w.headword].length > 0);
  take(real.filter((w) => key(w) === myKey && w.pinyinNumeric !== word.pinyinNumeric));
  take(
    real.filter((w) => {
      const s = toneless(w);
      return s.length === syl.length && s.some((x, i) => x === syl[i]);
    }),
  );
  take(real.filter((w) => toneless(w).length === syl.length && w.level === word.level));
  return out;
}

export function buildHearPick(
  word: Word,
  pool: readonly Word[],
  rng: () => number = Math.random,
): HearPick | undefined {
  const d = soundAlikeDistractors(word, pool, 3, rng);
  if (d.length < 3) return undefined;
  return {
    type: 'hear_pick',
    wordId: word.id,
    options: shuffle([word.headword, ...d.map((w) => w.headword)], rng),
    answer: word.headword,
  };
}

export function buildToneCheck(
  word: Word,
  rng: () => number = Math.random,
): ToneCheck | undefined {
  if (!toneCheckEligible(word)) return undefined;
  const tones = wordTones(word);
  const answer = tonePattern(word);
  const patterns = new Set<string>([answer]);
  // wrong answers: change one syllable's tone, preferring tones that are plausible confusions
  for (let guard = 0; patterns.size < 4 && guard < 40; guard++) {
    const t = [...tones];
    const i = Math.floor(rng() * t.length);
    t[i] = [1, 2, 3, 4][Math.floor(rng() * 4)]!;
    patterns.add(t.map(toneDigit).join(' + '));
  }
  if (patterns.size < 3) return undefined;
  return { type: 'tone_check', wordId: word.id, options: shuffle([...patterns].slice(0, 4), rng), answer };
}

/** Minimal pairs from the lexicon: same toneless syllables, different tones. */
export function generateTonePairs(
  words: readonly Word[],
  opts: { levels?: readonly Level[]; hasVerifiedClip?: (w: Word) => boolean } = {},
): Array<{ a: Word; b: Word }> {
  const groups = new Map<string, Word[]>();
  for (const w of words) {
    if (w.source !== 'tocfl' || !w.pinyinNumeric) continue;
    if (opts.levels && (!w.level || !opts.levels.includes(w.level))) continue;
    if (opts.hasVerifiedClip && !opts.hasVerifiedClip(w)) continue;
    const k = key(w);
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  const pairs: Array<{ a: Word; b: Word }> = [];
  for (const g of groups.values()) {
    // one word per distinct tone pattern
    const byPattern = new Map<string, Word>();
    for (const w of g) if (!byPattern.has(w.pinyinNumeric)) byPattern.set(w.pinyinNumeric, w);
    const uniq = [...byPattern.values()].filter(
      (w, i, a) => a.findIndex((x) => x.headword === w.headword) === i,
    );
    for (let i = 0; i < uniq.length; i++)
      for (let j = i + 1; j < uniq.length; j++) pairs.push({ a: uniq[i]!, b: uniq[j]! });
  }
  return pairs;
}

export function buildTonePair(
  word: Word,
  pairs: ReadonlyArray<{ a: Word; b: Word }>,
  rng: () => number = Math.random,
): TonePair | undefined {
  const mine = pairs.filter((p) => p.a.id === word.id || p.b.id === word.id);
  if (mine.length === 0) return undefined;
  const p = mine[Math.floor(rng() * mine.length)]!;
  return { type: 'tone_pair', a: p.a.id, b: p.b.id, play: p.a.id === word.id ? 'a' : 'b' };
}

export function buildListenUnderstand(
  sentence: SentenceBankEntry,
  pool: readonly SentenceBankEntry[],
  rng: () => number = Math.random,
): ListenUnderstand | undefined {
  const sameLesson = pool.filter((s) => s.id !== sentence.id && s.en !== sentence.en && s.lesson !== undefined && s.lesson === sentence.lesson && s.textbookId === sentence.textbookId);
  const sameLevel = pool.filter((s) => s.id !== sentence.id && s.en !== sentence.en && s.level === sentence.level);
  const others = shuffle([...sameLesson, ...sameLevel.filter((s) => !sameLesson.includes(s))], rng);
  const ens = [...new Set(others.map((s) => s.en))].slice(0, 2);
  if (ens.length < 2) return undefined;
  return {
    type: 'listen_understand',
    sentenceId: sentence.id,
    zh: sentence.zh,
    options: shuffle([sentence.en, ...ens], rng),
    answer: sentence.en,
  };
}

/** Novice sentences stay short for dictation. */
export function dictationEligible(s: SentenceBankEntry, config: ListeningConfig = LISTENING_CONFIG): boolean {
  const novice = levelIndex(s.level) <= levelIndex('N2');
  return !novice || [...s.zh.replace(/[，。？！、]/g, '')].length <= config.noviceSentenceMaxChars;
}

// ---- creating listening cards ----------------------------------------------

/**
 * A listening card is created for an item when its RECOGNITION card is Learned (Phase 21 shared term)
 * and it has a usable (verified/auto_ok) word clip. Pure: the caller persists the result.
 */
export function listeningCardsToCreate(
  cards: readonly SkillCard[],
  hasClip: ClipLookup,
): string[] {
  const have = new Set(cards.filter((c) => c.skill === 'listening').map((c) => c.item.id));
  return cards
    .filter(
      (c) =>
        c.skill === 'recognition' &&
        c.item.kind === 'word' &&
        unlocksListening(c) &&
        !have.has(c.item.id) &&
        hasClip('word', c.item.id),
    )
    .map((c) => c.item.id);
}

// ---- planning a session ----------------------------------------------------

export interface ListenPlanInput {
  lexicon: Lexicon;
  /** Due listening cards (any order; `rank` orders them study-order-first). */
  dueListening: readonly SkillCard[];
  /** Items with a recognition card in review+ and a clip, but no listening card yet. */
  newWordIds: readonly string[];
  /** Phase 29 Part B.4: new listening items this session (`ledger.newAllowance('listening')`). */
  newAllowed: number;
  hasClip: ClipLookup;
  sentences: readonly SentenceBankEntry[];
  /** Lower rank first (Phase 14 study order); absent = as given. */
  rank?: (wordId: string) => number;
  rng?: () => number;
  config?: ListeningConfig;
  /** Restrict a round to some words (a textbook lesson's listening round). */
  onlyWordIds?: ReadonlySet<string>;
  size?: number;
  /** Phase 19: seed for the session order (the session id). Default: drawn from `rng`. */
  seed?: string;
  /** Phase 19: keys of the cards shown just before (see orderSession's `recent`). */
  recent?: readonly (readonly string[])[];
}

/** Phase 19: a listening exercise is a sibling of every other card on the same word(s). */
export function describePlanItem(p: PlanItem): SessionCard {
  return { keys: p.wordIds.map((id) => `word:${id}`) };
}

export interface PlanItem {
  exercise: Exercise;
  /** The listening card this practises (undefined for a brand-new item). */
  card?: SkillCard;
  /** Items that receive evidence (a sentence gives one per word). */
  wordIds: string[];
}

/** Which exercise types an item has unlocked, given its listening stability. */
export function unlockedTypes(stability: number, config: ListeningConfig = LISTENING_CONFIG): ExerciseType[] {
  const u = config.unlock;
  const out: ExerciseType[] = ['hear_pick'];
  if (stability >= u.tone_check) out.push('tone_check', 'tone_pair');
  if (stability >= u.hear_type) out.push('hear_type');
  if (stability >= u.sentence_dictation) out.push('sentence_dictation', 'listen_understand');
  return out;
}

export function planListenSession(input: ListenPlanInput): OrderedSession<PlanItem> {
  // Phase 21: seeded when the session has a seed (a logged seed rebuilds the session exactly).
  const rng = input.rng ?? (input.seed ? seededRng(`${input.seed}:plan`) : Math.random);
  const config = input.config ?? LISTENING_CONFIG;
  const size = input.size ?? config.sessionSize;
  const all = input.lexicon.allWords();
  const rank = input.rank ?? (() => 0);
  const only = input.onlyWordIds;
  const inScope = (id: string) => !only || only.has(id);

  const due = [...input.dueListening]
    .filter((c) => inScope(c.item.id) && input.hasClip('word', c.item.id))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c.item.id) - rank(b.c.item.id) || a.i - b.i)
    .map((x) => x.c);
  const fresh = [...input.newWordIds]
    .filter(inScope)
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map((x) => x.id)
    .slice(0, Math.max(0, input.newAllowed));

  const queue: Array<{ wordId: string; card?: SkillCard }> = [
    ...due.map((c) => ({ wordId: c.item.id, card: c })),
    ...fresh.map((id) => ({ wordId: id })),
  ].slice(0, size);

  const pairs = generateTonePairs(all, { hasVerifiedClip: (w) => input.hasClip('word', w.id, true) });
  const clipSentences = input.sentences.filter((s) => input.hasClip('sentence', s.id) && dictationEligible(s, config));
  const plan: PlanItem[] = [];
  for (const q of queue) {
    const word = input.lexicon.byId(q.wordId);
    if (!word) continue;
    const stab = practiceStrengthOf(q.card);
    const options: Array<() => Exercise | undefined> = [];
    const verified = input.hasClip('word', word.id, true);
    for (const t of unlockedTypes(stab, config)) {
      if (t === 'hear_pick') options.push(() => buildHearPick(word, all, rng));
      else if (t === 'hear_type') options.push(() => ({ type: 'hear_type', wordId: word.id, headword: word.headword }));
      else if (t === 'tone_check' && verified) options.push(() => buildToneCheck(word, rng));
      else if (t === 'tone_pair' && verified) options.push(() => buildTonePair(word, pairs, rng));
      else if (t === 'sentence_dictation' || t === 'listen_understand') {
        const s = clipSentences.find((x) => x.zh.includes(word.headword));
        if (s)
          options.push(() =>
            t === 'sentence_dictation'
              ? { type: 'sentence_dictation', sentenceId: s.id, zh: s.zh }
              : buildListenUnderstand(s, input.sentences, rng),
          );
      }
    }
    for (const pick of shuffle(options, rng)) {
      const exercise = pick();
      if (!exercise) continue;
      plan.push({ exercise, ...(q.card ? { card: q.card } : {}), wordIds: [word.id] });
      break;
    }
  }
  // Phase 19: the shared order. Due cards before new ones and study order still decide the
  // bands; inside a band the order is a seeded shuffle.
  const band = new Map(plan.map((p) => [p, (p.card ? 0 : 1_000_000) + rank(p.wordIds[0]!)]));
  return orderSession(plan, (p) => ({ ...describePlanItem(p), band: band.get(p) ?? 0 }), {
    seed: input.seed ?? `listen-${Math.floor(rng() * 2 ** 32).toString(36)}`,
    recent: input.recent,
  });
}

/** ~20% of a normal review/cloze session's slots are listening exercises once the item has a listening card. */
export function shouldMixListening(rng: () => number, config: ListeningConfig = LISTENING_CONFIG): boolean {
  return rng() < config.mixShare;
}

/** A fresh listening card for an item (state `introduced`, FSRS-new); the caller persists it. */
export function blankListeningCard(wordId: string, now: Date): SkillCard {
  return {
    item: { kind: 'word', id: wordId },
    skill: 'listening',
    card: emptyCard(now),
    state: 'introduced',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}
