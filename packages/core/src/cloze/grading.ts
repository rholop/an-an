import { parseSyllableTone, splitPinyinSyllables } from '../pinyin.js';
import type { Word } from '../types.js';
import { normaliseAnswer } from '../journal/normalize.js';

export type ClozeInputMode = 'hanzi' | 'pinyin' | 'zhuyin';

/**
 * - 'correct': right answer, no hint needed.
 * - 'correct_wrong_tone': right word/sounds, tone wrong or left unmarked —
 *   phase doc §4's "right word, wrong tone" partial credit. hanzi mode
 *   never produces this (no tone information in characters).
 * - 'wrong': anything else.
 */
export type GradeResult = 'correct' | 'correct_wrong_tone' | 'wrong';

export interface GradeOptions {
  /** Ignore tone entirely — a 'correct_wrong_tone' outcome becomes
   * 'correct' instead. Default false. */
  toneInsensitive?: boolean;
}

function gradeHanzi(typed: string, word: Word): GradeResult {
  const normalizedTyped = normaliseAnswer(typed);
  const accepted = [word.headword, ...word.variants].map(normaliseAnswer);
  return accepted.includes(normalizedTyped) ? 'correct' : 'wrong';
}

export interface ParsedSyllable {
  base: string;
  tone: number;
  /** False only for pinyin's genuine ambiguity: no digit and no diacritic
   * could mean "neutral tone" (correctly unmarked) or "didn't bother typing
   * a tone" — the grader resolves this against the target's actual tone.
   * Always true for zhuyin, where absence of a mark unambiguously means
   * tone 1 (CLAUDE.md zhuyin convention). */
  toneSpecified: boolean;
}

const PINYIN_DIGIT_RE = /^([a-zü]+)([0-5])$/i;

/** Phase 21: the one typed-pinyin syllable parser (cloze, error items, listening dictation).
 * Digits 1–4, 5 or 0 for neutral, tone marks, or nothing (matches a genuinely neutral target). */
export function parseTypedPinyinSyllable(raw: string): ParsedSyllable {
  // "nv"/"lv" (and "u:") are common ASCII-IME shortcuts for ü.
  const trimmed = raw.normalize('NFC').trim().replace(/u:/gi, 'ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
  const digitMatch = PINYIN_DIGIT_RE.exec(trimmed);
  if (digitMatch) {
    const d = Number(digitMatch[2]);
    return { base: digitMatch[1]!.toLowerCase(), tone: d === 0 ? 5 : d, toneSpecified: true };
  }
  const { base, tone } = parseSyllableTone(trimmed);
  // parseSyllableTone only ever returns a tone other than the 5-fallback
  // when it actually found a diacritic — so tone !== 5 already proves a
  // mark was present. When it returns 5, that could be a genuine neutral
  // tone OR "no mark supplied at all"; grading resolves the ambiguity
  // against the target (see gradePinyin).
  return { base: base.toLowerCase(), tone, toneSpecified: tone !== 5 };
}

function parseTargetPinyinSyllable(raw: string): { base: string; tone: number } {
  const { base, tone } = parseSyllableTone(raw);
  return { base: base.toLowerCase(), tone };
}

/** Tones that differ, by syllable index (an unmarked syllable only matches a neutral target). */
export function toneMismatches(typed: readonly ParsedSyllable[], target: readonly { tone: number }[]): number[] {
  return typed.flatMap((t, i) => {
    const want = target[i]!.tone;
    const ok = t.toneSpecified ? t.tone === want : want === 5;
    return ok ? [] : [i];
  });
}

function gradeSyllables(
  typed: ParsedSyllable[],
  target: { base: string; tone: number }[],
  options: GradeOptions,
): GradeResult {
  if (typed.length !== target.length) return 'wrong';
  if (typed.some((t, i) => t.base !== target[i]!.base)) return 'wrong';
  if (options.toneInsensitive) return 'correct';

  return toneMismatches(typed, target).length === 0 ? 'correct' : 'correct_wrong_tone';
}

function gradePinyin(typed: string, word: Word, options: GradeOptions): GradeResult {
  const typedSyllables = splitPinyinSyllables(typed).map(parseTypedPinyinSyllable);
  const targetSyllables = splitPinyinSyllables(word.pinyin).map(parseTargetPinyinSyllable);
  if (typedSyllables.length === 0) return 'wrong';
  return gradeSyllables(typedSyllables, targetSyllables, options);
}

const ZHUYIN_NEUTRAL_PREFIX = '˙';
const ZHUYIN_TONE_SUFFIX: Record<string, number> = { ˊ: 2, ˇ: 3, ˋ: 4 };

/** Phase 21: the one zhuyin syllable parser. ˙ (neutral) is accepted before or after the syllable. */
export function parseZhuyinSyllable(raw: string): ParsedSyllable {
  const s = raw.normalize('NFC').trim();
  if (s.includes(ZHUYIN_NEUTRAL_PREFIX)) {
    return { base: s.split(ZHUYIN_NEUTRAL_PREFIX).join(''), tone: 5, toneSpecified: true };
  }
  const lastChar = s.slice(-1);
  if (lastChar in ZHUYIN_TONE_SUFFIX) {
    return { base: s.slice(0, -1), tone: ZHUYIN_TONE_SUFFIX[lastChar]!, toneSpecified: true };
  }
  // No mark at all unambiguously means tone 1 in zhuyin (unlike pinyin).
  return { base: s, tone: 1, toneSpecified: true };
}

function gradeZhuyin(typed: string, word: Word, options: GradeOptions): GradeResult {
  const typedSyllables = typed.trim().split(/\s+/).filter(Boolean).map(parseZhuyinSyllable);
  // word.zhuyin is MOE-sourced (CLAUDE.md: MOE is the reading authority) —
  // graded against directly rather than re-derived from word.pinyin through
  // our own converter, so grading never second-guesses the authoritative
  // reading.
  const targetSyllables = word.zhuyin.split(/\s+/).filter(Boolean).map(parseZhuyinSyllable);
  if (typedSyllables.length === 0) return 'wrong';
  return gradeSyllables(typedSyllables, targetSyllables, options);
}

/**
 * Grades a learner's typed cloze answer against the specific Word (one
 * sense, one reading — CLAUDE.md "items are word + sense") the exercise is
 * testing. Heteronyms (e.g. 還 hái vs. huán) are handled for free: each
 * sense is its own Word with its own `pinyin`, so grading always compares
 * against the one reading this exercise actually means.
 */
export function gradeClozeAnswer(typed: string, word: Word, mode: ClozeInputMode, options: GradeOptions = {}): GradeResult {
  if (!typed.trim()) return 'wrong';
  switch (mode) {
    case 'hanzi':
      return gradeHanzi(typed, word);
    case 'pinyin':
      return gradePinyin(typed, word, options);
    case 'zhuyin':
      return gradeZhuyin(typed, word, options);
  }
}
