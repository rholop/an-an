import { pickDistractors } from '../cloze/distractors.js';
import { selectClozeSource, type ClozeSourceCandidate, type SelectClozeSourceOptions } from '../cloze/source.js';
import type { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { LEECH_TREATMENTS, type LeechTreatment, type SkillCard } from './types.js';

/**
 * Next untried leech treatment for a card already flagged `leech`. Cycles
 * through LEECH_TREATMENTS in order, skipping ones already recorded in
 * leechTreatmentsTried; wraps around (re-offers the first) once all four
 * have been tried at least once. char_breakdown (Phase 2), new_context and
 * contrast_confusable (Phase 4, see below) are real; mnemonic_prompt is
 * still a stub the UI can label "coming soon" — but this still returns
 * whichever treatment is next in rotation so the data model is ready for
 * it too.
 */
export function nextLeechTreatment(card: Pick<SkillCard, 'leechTreatmentsTried'>): LeechTreatment {
  const untried = LEECH_TREATMENTS.find((t) => !card.leechTreatmentsTried.includes(t));
  return untried ?? LEECH_TREATMENTS[card.leechTreatmentsTried.length % LEECH_TREATMENTS.length]!;
}

/**
 * new_context leech treatment (phase doc §7): "pick a sentence not seen
 * before" — the same cloze source priority as a normal review, but
 * excluding sentences already shown for this item, forcing a fresh context
 * the familiar-but-failing association can't just pattern-match against.
 */
export function pickNewContextSentence(
  word: Word,
  opts: SelectClozeSourceOptions,
  previouslyShownZh: ReadonlySet<string>,
): ClozeSourceCandidate | null {
  return selectClozeSource(word, { ...opts, excludeZh: previouslyShownZh });
}

export interface ConfusableContrast {
  target: Word;
  confusable: Word;
}

/**
 * contrast_confusable leech treatment (phase doc §7): "side-by-side MC with
 * the word it's confused with" — reuses the same confusable-ranking
 * distractors.ts already uses for rung-2 multiple choice, just asking for
 * one. Returns null if the lexicon has no eligible confusable at all (e.g.
 * a word alone at its level).
 */
export function pickConfusableContrast(target: Word, lexicon: Lexicon, rng: () => number = Math.random): ConfusableContrast | null {
  const [confusable] = pickDistractors(target, lexicon, { count: 1, preferConfusable: true }, rng);
  return confusable ? { target, confusable } : null;
}

export interface CharInWord {
  ch: string;
  /** This character's syllable IN THIS WORD (MOE reading of the word), e.g. 還 in 還是 = hái. */
  pinyin: string;
  zhuyin: string;
  /** The character's own entry with that same reading, if it is one. */
  glossEn?: string;
}

const toneless = (numeric: string) => numeric.replace(/[0-9]/g, '').toLowerCase();

/**
 * Phase 21 Part I: the leech panel's character breakdown uses each character's reading in this
 * word (from the word's MOE-verified reading), never the first dictionary entry of the character:
 * 還 in 還是 is hái, not huán; 長 in 長大 is zhǎng.
 */
export function charsInWord(word: Pick<Word, 'chars' | 'pinyin' | 'pinyinNumeric' | 'zhuyin'>, lexicon: Lexicon): CharInWord[] {
  const py = word.pinyin.trim().split(/\s+/);
  const num = word.pinyinNumeric.trim().split(/\s+/);
  const zy = word.zhuyin.trim().split(/\s+/);
  const aligned = py.length === word.chars.length;
  return word.chars.map((ch, i) => {
    const pinyin = aligned ? (py[i] ?? '') : '';
    const zhuyin = zy.length === word.chars.length ? (zy[i] ?? '') : '';
    const n = num.length === word.chars.length ? (num[i] ?? '') : '';
    const entries = lexicon.charInfo(ch).words;
    const same =
      entries.find((w) => w.pinyinNumeric.trim() === n) ??
      entries.find((w) => n && toneless(w.pinyinNumeric) === toneless(n));
    return { ch, pinyin, zhuyin, ...(same ? { glossEn: same.glossEn } : {}) };
  });
}

/**
 * Phase 21: is an AI-supplied reading of an unlisted word one the MOE-verified lexicon gives these
 * characters? Each syllable must be a reading of its character (tones included).
 * `undefined` = can't tell (a character with no entry, or syllables that don't line up).
 */
export function readingMatchesDictionary(text: string, pinyin: string, lexicon: Lexicon): boolean | undefined {
  const chars = [...text];
  const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}]/gu, '');
  const syllables = pinyin.trim().split(/[\s·'’-]+/).filter(Boolean).map(norm);
  if (syllables.length !== chars.length) return undefined;
  for (let i = 0; i < chars.length; i++) {
    const readings = lexicon.charInfo(chars[i]!).words.map((w) => norm(w.pinyin));
    if (readings.length === 0) return undefined;
    if (!readings.includes(syllables[i]!)) return false;
  }
  return true;
}
