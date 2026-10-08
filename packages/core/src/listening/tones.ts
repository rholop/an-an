import type { Word } from '../types.js';
import { toneDigit } from '../journal/normalize.js';

/** Tones per syllable from the lexicon's MOE-derived numeric pinyin ("ka1 fei1" → [1,1]); 5 = neutral. */
export function wordTones(w: Pick<Word, 'pinyinNumeric'>): number[] {
  return w.pinyinNumeric
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => Number(/([1-5])$/.exec(s)?.[1] ?? 5));
}

/** Syllables without tones ("ka fei"). */
export function toneless(w: Pick<Word, 'pinyinNumeric'>): string[] {
  return w.pinyinNumeric
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/[1-5]$/, ''));
}

/** "3 + 4" — the answer format of the tone check (the dictionary tones shown in the app). */
export function tonePattern(w: Pick<Word, 'pinyinNumeric'>): string {
  return wordTones(w).map(toneDigit).join(' + ');
}

/**
 * Words whose spoken tones normally change are excluded from the tone check, so audio and the
 * expected answer never disagree: anything with 一 or 不 (their sandhi), and any 3rd + 3rd tone sequence.
 */
export function toneCheckEligible(w: Pick<Word, 'headword' | 'variants' | 'pinyinNumeric'>): boolean {
  if (/[一不]/.test(w.headword)) return false;
  const t = wordTones(w);
  if (t.length === 0) return false;
  for (let i = 0; i + 1 < t.length; i++) if (t[i] === 3 && t[i + 1] === 3) return false;
  return true;
}

/** Index of syllables whose tone differs between two readings with the same toneless syllables. */
export function toneDiffs(a: readonly number[], b: readonly number[]): number[] {
  return a.flatMap((t, i) => (t !== b[i] ? [i] : []));
}
