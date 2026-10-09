// Phase 23 Part C: the "Pinyin & tones" tab. Pronunciation-focused practice on the `reading` skill
// (a word's pinyin and tones from its characters). Readings are always the MOE ones the app shows;
// questions ask for the dictionary (citation) tone, with a one-line note where the spoken tone
// changes (一, 不, 3rd + 3rd). Pure; the seed makes a session repeatable.

import { gradeWordDictation } from '../listening/grading.js';
import { toneCheckEligible, toneless as tonelessSyllables, wordTones } from '../listening/tones.js';
import { parseSyllableTone, splitPinyinSyllables } from '../pinyin.js';
import { hashText } from '../hash.js';
import { glossFor } from '../gloss/context.js';
import type { ConfusableIndex } from '../confusables/index.js';
import type { SkillCard } from '../learner/types.js';
import { orderSession, seededRng, seededShuffle } from '../session/orderSession.js';
import type { Evidence, Word } from '../types.js';

export const PINYIN_PRACTICE_CONFIG = {
  /** Items (words) per session. */
  sessionSize: 30,
  matchSize: 5,
  sortSize: 6,
  /** Tone-confusion stats look back this many days. */
  statsDays: 7,
};

// ---------------------------------------------------------------------------------------------
// Syllables, tone marks and zhuyin

const VOWELS = 'aeiouü';
const MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

/** A toneless pinyin syllable with its tone mark ("lao", 3 → "lǎo"); tone 5 = neutral (no mark). */
export function markTone(base: string, tone: number): string {
  if (tone < 1 || tone > 4) return base;
  const lower = base.toLowerCase();
  let at = lower.indexOf('a');
  if (at < 0) at = lower.indexOf('e');
  if (at < 0 && lower.includes('ou')) at = lower.indexOf('o');
  if (at < 0) for (let i = lower.length - 1; i >= 0; i--) if (VOWELS.includes(lower[i]!)) { at = i; break; }
  if (at < 0) return base;
  const v = lower[at]!;
  const marked = MARKS[v]![tone - 1]!;
  return base.slice(0, at) + (base[at] === v ? marked : marked.toUpperCase()) + base.slice(at + 1);
}

/** Tone marks for zhuyin (1st tone unmarked; neutral is the dot before the syllable). */
export const ZHUYIN_TONE_MARKS = ['', 'ˊ', 'ˇ', 'ˋ', '˙'] as const;
const ZHUYIN_MARK_RE = /[ˊˇˋ˙]/g;

export interface Syllable {
  char: string;
  /** Pinyin without the tone ("lao"). */
  base: string;
  /** 1–4, 5 = neutral. */
  tone: number;
  /** Pinyin with the tone mark ("lǎo"). */
  pinyin: string;
  /** Zhuyin without the tone mark ("ㄌㄠ"). */
  zhuyinBase: string;
  /** Zhuyin with the tone mark ("ㄌㄠˇ"). */
  zhuyin: string;
}

/** A word's syllables (one per character when the reading lines up with the characters). */
export function wordSyllables(w: Pick<Word, 'headword' | 'pinyin' | 'pinyinNumeric' | 'zhuyin'>): Syllable[] {
  const py = splitPinyinSyllables(w.pinyin);
  const tones = wordTones(w);
  const bases = tonelessSyllables(w);
  const zh = w.zhuyin.trim().split(/\s+/).filter(Boolean);
  const chars = [...w.headword];
  return bases.map((base, i) => ({
    char: chars.length === bases.length ? chars[i]! : '',
    base,
    tone: tones[i] ?? 5,
    pinyin: py[i] ?? markTone(base, tones[i] ?? 5),
    zhuyinBase: (zh[i] ?? '').replace(ZHUYIN_MARK_RE, ''),
    zhuyin: zh[i] ?? '',
  }));
}

/** Zhuyin with a given tone ("ㄌㄠ", 3 → "ㄌㄠˇ"; neutral puts the dot first, as MOE writes it). */
export function zhuyinWithTone(base: string, tone: number): string {
  if (tone === 5) return `˙${base}`;
  return `${base}${ZHUYIN_TONE_MARKS[tone - 1] ?? ''}`;
}

/** Can this word be practised here: a reading with one syllable per character. */
export function practisable(w: Pick<Word, 'headword' | 'pinyin' | 'pinyinNumeric' | 'zhuyin'>): boolean {
  if (!w.pinyinNumeric.trim()) return false;
  const syl = wordSyllables(w);
  return syl.length > 0 && syl.length === [...w.headword].length && syl.every((s) => s.char);
}

// ---------------------------------------------------------------------------------------------
// Tone changes in speech (citation tone asked; the note says what is said)

/**
 * One-line notes where the spoken tone differs from the dictionary tone the app asks for:
 * 一 and 不 change before certain tones, and the first of two 3rd tones is said as a 2nd.
 */
export function sandhiNotes(w: Pick<Word, 'headword' | 'pinyin' | 'pinyinNumeric' | 'zhuyin'>): string[] {
  const syl = wordSyllables(w);
  const notes: string[] = [];
  for (let i = 0; i < syl.length; i++) {
    const s = syl[i]!;
    const next = syl[i + 1];
    if (!next || next.tone === 5) continue;
    if (s.char === '不' && s.tone === 4 && next.tone === 4) notes.push('不 is said bú before a 4th tone.');
    else if (s.char === '一' && s.tone === 1) {
      if (next.tone === 4) notes.push('一 is said yí before a 4th tone.');
      else notes.push(`一 is said yì before a ${ordinal(next.tone)} tone.`);
    } else if (s.tone === 3 && next.tone === 3)
      notes.push(`${s.char} is said ${markTone(s.base, 2)} before another 3rd tone (${s.pinyin} ${next.pinyin} → ${markTone(s.base, 2)} ${next.pinyin}).`);
  }
  return notes;
}

const ordinal = (t: number) => ['1st', '2nd', '3rd', '4th'][t - 1] ?? 'neutral';

/** "2 + 4" for two-syllable words (the tone-pattern sort); neutral shows as 5... as "0". */
export const tonePatternLabel = (tones: readonly number[]): string => tones.map((t) => (t === 5 ? '0' : String(t))).join(' + ');

// ---------------------------------------------------------------------------------------------
// Near misses

const SOUND_SWAPS: [RegExp, string][] = [
  [/^zh/, 'z'],
  [/^ch/, 'c'],
  [/^sh/, 's'],
  [/^z(?!h)/, 'zh'],
  [/^c(?!h)/, 'ch'],
  [/^s(?!h)/, 'sh'],
  [/ang$/, 'an'],
  [/eng$/, 'en'],
  [/ing$/, 'in'],
  [/an$/, 'ang'],
  [/en$/, 'eng'],
  [/in$/, 'ing'],
  [/^n/, 'l'],
  [/^l/, 'n'],
];

/** Tones learners swap most (2↔3 above all). */
const TONE_SWAP: Record<number, number[]> = { 1: [4, 2], 2: [3, 1], 3: [2, 4], 4: [1, 3], 5: [1, 4] };

/**
 * A wrong spelling one step from the real one: one syllable in another tone, or one sound changed
 * (sh/s, an/ang, n/l…). `kind` says which, for grading.
 */
export function nearMissPinyin(
  w: Pick<Word, 'headword' | 'pinyin' | 'pinyinNumeric' | 'zhuyin'>,
  seed: string,
): { syllables: { base: string; tone: number }[]; kind: 'tone' | 'sound' } {
  const syl = wordSyllables(w);
  const rng = seededRng(`${seed}|${w.headword}|near`);
  const i = Math.floor(rng() * syl.length);
  const s = syl[i]!;
  const copy = syl.map((x) => ({ base: x.base, tone: x.tone }));
  const sound = rng() < 0.35 ? SOUND_SWAPS.find(([re]) => re.test(s.base)) : undefined;
  if (sound) {
    copy[i] = { base: s.base.replace(sound[0], sound[1]), tone: s.tone };
    return { syllables: copy, kind: 'sound' };
  }
  const options = TONE_SWAP[s.tone] ?? [1];
  copy[i] = { base: s.base, tone: options[Math.floor(rng() * options.length)]! };
  return { syllables: copy, kind: 'tone' };
}

// ---------------------------------------------------------------------------------------------
// Exercises

export type PinyinExercise =
  | { kind: 'tones'; word: Word }
  | { kind: 'match'; words: Word[] }
  | { kind: 'chars'; word: Word; options: Word[] }
  | { kind: 'type'; word: Word }
  | { kind: 'which'; word: Word; options: { syllables: { base: string; tone: number }[]; right: boolean; kind?: 'tone' | 'sound' }[] }
  | { kind: 'sort'; words: Word[]; patterns: string[] }
  | { kind: 'lookalike'; word: Word; options: Word[] };

export type PinyinExerciseKind = PinyinExercise['kind'];

export const PINYIN_EXERCISE_LABELS: Record<PinyinExerciseKind, string> = {
  tones: 'Pick the tones',
  match: 'Match pinyin to characters',
  chars: 'Pick the characters',
  type: 'Type the pinyin',
  which: 'Which pinyin is right?',
  sort: 'Tone pattern sort',
  lookalike: 'Look-alike characters',
};

/** The words an exercise practises. */
export const exerciseWords = (e: PinyinExercise): Word[] => ('words' in e ? e.words : [e.word]);

/** Per-word result of an answer: the evidence kind, and what went wrong. */
export interface PinyinResult {
  wordId: string;
  kind: 'reading_correct' | 'reading_tone_wrong' | 'reading_wrong';
  /** Wrong tones (reading_tone_wrong), for the tone stats. */
  tones?: { expected: number; given: number }[];
  /** A wrong pick: the word picked instead. */
  pickedId?: string;
}

/** Pick the tones: graded per syllable. */
export function gradeTones(w: Word, given: readonly number[]): { result: PinyinResult; wrongAt: number[] } {
  const syl = wordSyllables(w);
  const wrongAt = syl.flatMap((s, i) => (given[i] !== s.tone ? [i] : []));
  const tones = wrongAt.map((i) => ({ expected: syl[i]!.tone, given: given[i] ?? 0 }));
  return {
    wrongAt,
    result: wrongAt.length === 0 ? { wordId: w.id, kind: 'reading_correct' } : { wordId: w.id, kind: 'reading_tone_wrong', tones },
  };
}

/** Type the pinyin (or zhuyin): right syllables with a wrong tone = "right sound, wrong tone". */
export function gradeTypedReading(w: Word, typed: string): { result: PinyinResult; outcome: 'correct' | 'wrong_tone' | 'wrong'; wrongAt: number[] } {
  const r = gradeWordDictation(typed, w);
  if (r.outcome === 'correct' && r.input === 'characters') return { result: { wordId: w.id, kind: 'reading_wrong' }, outcome: 'wrong', wrongAt: [] };
  if (r.outcome === 'correct') return { result: { wordId: w.id, kind: 'reading_correct' }, outcome: 'correct', wrongAt: [] };
  if (r.outcome === 'wrong_tone') {
    const syl = wordSyllables(w);
    const typedTones = typedSyllableTones(typed);
    const tones = r.toneWrongAt.map((i) => ({ expected: syl[i]!.tone, given: typedTones[i] ?? 0 }));
    return { result: { wordId: w.id, kind: 'reading_tone_wrong', tones }, outcome: 'wrong_tone', wrongAt: r.toneWrongAt };
  }
  return { result: { wordId: w.id, kind: 'reading_wrong' }, outcome: 'wrong', wrongAt: [] };
}

function typedSyllableTones(typed: string): number[] {
  const t = typed.trim();
  if (/[ㄅ-ㄯ]/.test(t))
    return t.split(/\s+/).map((z) => (z.includes('˙') ? 5 : z.includes('ˊ') ? 2 : z.includes('ˇ') ? 3 : z.includes('ˋ') ? 4 : 1));
  return t.split(/[\s']+/).filter(Boolean).map((s) => {
    const digit = /([0-5])$/.exec(s);
    if (digit) return Number(digit[1]) === 0 ? 5 : Number(digit[1]);
    return parseSyllableTone(s).tone;
  });
}

/** A pick between options (Which pinyin, Pick the characters, Look-alikes, Match): right, or the
 * wrong one picked. A wrong pinyin that differs only in tone is "right sound, wrong tone". */
export function gradePick(
  w: Word,
  picked: { wordId?: string; syllables?: { base: string; tone: number }[] },
): PinyinResult {
  if (picked.wordId !== undefined) {
    return picked.wordId === w.id ? { wordId: w.id, kind: 'reading_correct' } : { wordId: w.id, kind: 'reading_wrong', pickedId: picked.wordId };
  }
  const want = wordSyllables(w);
  const got = picked.syllables ?? [];
  if (got.length === want.length && got.every((g, i) => g.base === want[i]!.base && g.tone === want[i]!.tone))
    return { wordId: w.id, kind: 'reading_correct' };
  if (got.length === want.length && got.every((g, i) => g.base === want[i]!.base)) {
    const tones = want.flatMap((s, i) => (got[i]!.tone !== s.tone ? [{ expected: s.tone, given: got[i]!.tone }] : []));
    return { wordId: w.id, kind: 'reading_tone_wrong', tones };
  }
  return { wordId: w.id, kind: 'reading_wrong' };
}

/** Match: the pinyin tapped for a word (a word's own reading, or another word's). */
export function gradeMatch(w: Word, pickedWord: Word): PinyinResult {
  if (pickedWord.id === w.id || pickedWord.pinyin === w.pinyin) return { wordId: w.id, kind: 'reading_correct' };
  const r = gradePick(w, { syllables: wordSyllables(pickedWord).map((s) => ({ base: s.base, tone: s.tone })) });
  return r.kind === 'reading_correct' ? r : { ...r, pickedId: pickedWord.id };
}

/** Tone pattern sort: the pattern put for a word. */
export function gradeSort(w: Word, pattern: string): PinyinResult {
  const want = wordSyllables(w).map((s) => s.tone);
  if (tonePatternLabel(want) === pattern) return { wordId: w.id, kind: 'reading_correct' };
  const given = pattern.split(' + ').map((x) => (x === '0' ? 5 : Number(x)));
  const tones = want.flatMap((t, i) => (given[i] !== t ? [{ expected: t, given: given[i] ?? 0 }] : []));
  return { wordId: w.id, kind: 'reading_tone_wrong', tones };
}

/** Evidence for a result (the word's reading card; source 'pinyin'). */
export function readingEvidence(r: PinyinResult, at: Date): Evidence {
  return {
    item: { kind: 'word', id: r.wordId },
    skill: 'reading',
    kind: r.kind,
    at,
    context: {
      source: 'pinyin',
      ...(r.tones && r.tones.length > 0 ? { tones: r.tones } : {}),
      ...(r.pickedId ? { pickedId: r.pickedId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tone stats

export interface ToneConfusion {
  /** The right tone and the one given (1–4, 5 = neutral), most frequent first. */
  expected: number;
  given: number;
  count: number;
}

/** "You mix up 2nd and 3rd tone most": tone pairs from reading_tone_wrong in the last `days` days. */
export function toneConfusions(
  evidence: readonly Pick<Evidence, 'kind' | 'at' | 'context'>[],
  now: Date,
  days = PINYIN_PRACTICE_CONFIG.statsDays,
): ToneConfusion[] {
  const since = now.getTime() - days * 86_400_000;
  const counts = new Map<string, ToneConfusion>();
  for (const e of evidence) {
    if (e.kind !== 'reading_tone_wrong' || e.at.getTime() < since || e.at.getTime() > now.getTime()) continue;
    for (const t of e.context?.tones ?? []) {
      const k = `${t.expected}>${t.given}`;
      const c = counts.get(k) ?? { expected: t.expected, given: t.given, count: 0 };
      c.count++;
      counts.set(k, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.expected - b.expected);
}

/** Unordered pairs ("2 and 3") with both directions added up, most frequent first. */
export function tonePairs(confusions: readonly ToneConfusion[]): { a: number; b: number; count: number }[] {
  const m = new Map<string, { a: number; b: number; count: number }>();
  for (const c of confusions) {
    const [a, b] = [Math.min(c.expected, c.given), Math.max(c.expected, c.given)];
    const k = `${a}-${b}`;
    const x = m.get(k) ?? { a, b, count: 0 };
    x.count += c.count;
    m.set(k, x);
  }
  return [...m.values()].sort((x, y) => y.count - x.count || x.a - y.a);
}

/** Tone mistakes per word (which words to practise first). */
export function toneTroubleByWord(evidence: readonly Pick<Evidence, 'item' | 'kind' | 'at'>[], now: Date, days = 30): Map<string, number> {
  const since = now.getTime() - days * 86_400_000;
  const m = new Map<string, number>();
  for (const e of evidence)
    if ((e.kind === 'reading_tone_wrong' || e.kind === 'reading_wrong') && e.item.kind === 'word' && e.at.getTime() >= since)
      m.set(e.item.id, (m.get(e.item.id) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------------------------
// The session

export interface PinyinSessionInput {
  /** Phase 29: the reading queue from the ledger (`ledger.practice('reading')`): cards in this review
   * session, New cards under the Pinyin allowance, and every answered card, weakest first. */
  queue: { due: readonly SkillCard[]; fresh: readonly SkillCard[]; answered: readonly SkillCard[] };
  wordById: (id: string) => Word | undefined;
  now: Date;
  seed: string;
  /** Mistakes per word (`toneTroubleByWord`). */
  trouble?: ReadonlyMap<string, number>;
  confusables?: ConfusableIndex;
  /** Known, due and current-level word ids (plausible options). */
  preferred?: ReadonlySet<string>;
  confusions?: ReadonlyMap<string, ReadonlySet<string>>;
  size?: number;
  /** Also practise reading cards that aren't due (the "Practise anyway" button). */
  extra?: boolean;
  /** Exercises to leave out (e.g. none, or a single kind for testing). */
  only?: readonly PinyinExerciseKind[];
}

/**
 * A session: due reading cards first, then the words the learner gets wrong most, then a few New
 * reading cards (and with `extra`, the weakest of the rest), up to `size` words, spread over the
 * seven exercises and put in the shared session order.
 */
export function planPinyinSession(input: PinyinSessionInput): PinyinExercise[] {
  const size = input.size ?? PINYIN_PRACTICE_CONFIG.sessionSize;
  const trouble = input.trouble ?? new Map<string, number>();
  const words: Word[] = [];
  const seen = new Set<string>();
  const add = (c: SkillCard) => {
    if (words.length >= size || seen.has(c.item.id) || c.flags.excluded || c.flags.snoozed) return;
    const w = c.item.kind === 'word' ? input.wordById(c.item.id) : undefined;
    if (!w || !practisable(w)) return;
    seen.add(c.item.id);
    words.push(w);
  };
  const isReading = (c: SkillCard) => c.skill === 'reading' && c.item.kind === 'word';
  const rng = seededRng(input.seed);
  const due = seededShuffle(input.queue.due.filter(isReading), rng);
  due.sort((a, b) => (trouble.get(b.item.id) ?? 0) - (trouble.get(a.item.id) ?? 0));
  due.forEach(add);
  input.queue.answered
    .filter((c) => isReading(c) && (trouble.get(c.item.id) ?? 0) > 0)
    .sort((a, b) => (trouble.get(b.item.id) ?? 0) - (trouble.get(a.item.id) ?? 0))
    .forEach(add);
  // New reading cards: the ledger already capped them at the Pinyin allowance (Phase 29 Part B.4).
  seededShuffle(input.queue.fresh.filter(isReading), rng).forEach(add);
  if (input.extra) input.queue.answered.filter(isReading).forEach(add);
  return buildExercises(words, input);
}

function buildExercises(words: Word[], input: PinyinSessionInput): PinyinExercise[] {
  const allowed = new Set<PinyinExerciseKind>(input.only ?? ['tones', 'match', 'chars', 'type', 'which', 'sort', 'lookalike']);
  const rng = seededRng(`${input.seed}|kinds`);
  const out: PinyinExercise[] = [];
  let rest = [...words];

  // one tone-pattern sort: 6 two-syllable words whose spoken tones are the dictionary tones
  if (allowed.has('sort')) {
    const two = rest.filter((w) => [...w.headword].length === 2 && toneCheckEligible(w));
    if (two.length >= PINYIN_PRACTICE_CONFIG.sortSize) {
      const group = two.slice(0, PINYIN_PRACTICE_CONFIG.sortSize);
      const patterns = [...new Set(group.map((w) => tonePatternLabel(wordTones(w))))].sort();
      out.push({ kind: 'sort', words: group, patterns });
      rest = rest.filter((w) => !group.includes(w));
    }
  }
  // one match grid of 5, near-misses together where possible (same syllables in another tone)
  if (allowed.has('match') && rest.length >= PINYIN_PRACTICE_CONFIG.matchSize + 2) {
    const group = matchGroup(rest, PINYIN_PRACTICE_CONFIG.matchSize);
    out.push({ kind: 'match', words: group });
    rest = rest.filter((w) => !group.includes(w));
  }
  const singles: PinyinExerciseKind[] = (['tones', 'type', 'which', 'chars', 'lookalike'] as const).filter((k) => allowed.has(k));
  rest.forEach((w, i) => {
    const order = rotate(singles, i + Math.floor(rng() * singles.length));
    for (const kind of order) {
      const ex = single(kind, w, input);
      if (ex) {
        out.push(ex);
        return;
      }
    }
  });
  const ordered = orderSession(
    out,
    (e) => ({ keys: exerciseWords(e).flatMap((w) => [`word:${w.id}`, `zh:${w.headword}`]) }),
    { seed: input.seed, minSiblingGap: 3 },
  );
  // a word in two exercises is rare (groups and singles never share words), so nothing is deferred
  return [...ordered];
}

const rotate = <T>(a: readonly T[], k: number): T[] => (a.length === 0 ? [] : a.map((_, i) => a[(i + k) % a.length]!));

function single(kind: PinyinExerciseKind, w: Word, input: PinyinSessionInput): PinyinExercise | undefined {
  const seed = input.seed;
  const confusedWith = input.confusions?.get(w.id);
  const opts = {
    seed,
    ...(input.preferred ? { preferred: input.preferred } : {}),
    ...(confusedWith ? { confusedWith } : {}),
  };
  switch (kind) {
    case 'tones':
    case 'type':
      return { kind, word: w };
    case 'which': {
      const miss = nearMissPinyin(w, seed);
      const right = { syllables: wordSyllables(w).map((s) => ({ base: s.base, tone: s.tone })), right: true };
      const wrong = { syllables: miss.syllables, right: false, kind: miss.kind };
      const first = parseInt(hashText(`${seed}|${w.id}|which`), 36) % 2 === 0;
      return { kind, word: w, options: first ? [right, wrong] : [wrong, right] };
    }
    case 'chars': {
      const picks = input.confusables?.pick(w, { ...opts, mode: 'sound' }) ?? [];
      // one right answer: the English hint must tell them apart, and none may share the reading
      const options = picks.filter((p) => p.pinyin !== w.pinyin || glossFor(p) !== glossFor(w));
      if (options.length < 3) return undefined;
      return { kind, word: w, options: shuffleIn(w, options.slice(0, 3), `${seed}|chars`) };
    }
    case 'lookalike': {
      const picks = input.confusables?.pick(w, { ...opts, mode: 'visual' }) ?? [];
      // the pinyin is shown too, so an option with the same reading would also be right
      const options = picks.filter((p) => p.pinyinNumeric !== w.pinyinNumeric);
      if (options.length < 3) return undefined;
      return { kind, word: w, options: shuffleIn(w, options.slice(0, 3), `${seed}|look`) };
    }
    default:
      return undefined;
  }
}

/** The target placed among the distractors at a seeded position. */
export function shuffleIn(target: Word, others: readonly Word[], seed: string): Word[] {
  return seededShuffle([target, ...others], seededRng(`${seed}|${target.id}`));
}

/** Words for a match grid: start from the first word and prefer words sharing its syllables (near misses). */
function matchGroup(words: readonly Word[], n: number): Word[] {
  const first = words[0]!;
  const key = (w: Word) => tonelessSyllables(w).join(' ');
  const near = words.slice(1).filter((w) => tonelessSyllables(w).some((s) => tonelessSyllables(first).includes(s)));
  const group = [first, ...near.slice(0, n - 1)];
  for (const w of words) {
    if (group.length >= n) break;
    if (!group.includes(w) && !group.some((g) => g.pinyin === w.pinyin && key(g) === key(w))) group.push(w);
  }
  // two words with the very same pinyin would make the grid ambiguous
  const byPinyin = new Set<string>();
  return group.filter((w) => (byPinyin.has(w.pinyin) ? false : (byPinyin.add(w.pinyin), true)));
}
