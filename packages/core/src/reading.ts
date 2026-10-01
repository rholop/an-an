import { pickHeteronymReading, type Confidence } from './heteronyms.js';
import type { Lexicon } from './lexicon.js';
import { toPinyinNumeric } from './pinyin.js';
import type { Token } from './segment.js';

export interface ReadingResult {
  pinyin: string;
  zhuyin: string;
  confidence: Confidence;
}

export interface ReadingContext {
  prevToken?: Token;
  nextToken?: Token;
}

const EMPTY: ReadingResult = { pinyin: '', zhuyin: '', confidence: 'high' };

/**
 * Phrase-level lookup first, then small context rules for single-character
 * heteronyms. Never returns a confident wrong answer: anything genuinely
 * ambiguous comes back `confidence: 'low'` instead of guessing.
 */
export function resolveReading(
  token: Token,
  context: ReadingContext,
  lexicon: Lexicon,
): ReadingResult {
  if (token.kind === 'unknown') return { pinyin: '', zhuyin: '', confidence: 'low' };
  if (token.kind !== 'word') return EMPTY;

  const candidates = lexicon.lookup(token.text);
  if (candidates.length === 0) {
    // Defensive: token.kind === 'word' should always have >=1 lexicon match
    // by construction of segment(), but never guess if it somehow doesn't.
    return { pinyin: '', zhuyin: '', confidence: 'low' };
  }
  if (candidates.length === 1) {
    const w = candidates[0]!;
    return { pinyin: w.pinyin, zhuyin: w.zhuyin, confidence: 'high' };
  }

  // Multiple senses share this exact headword/variant spelling. For a
  // single character, try the heteronym context-rule table first.
  const chars = [...token.text];
  if (chars.length === 1) {
    const picked = pickHeteronymReading(
      chars[0]!,
      { before: context.prevToken?.text, after: context.nextToken?.text },
      candidates.map((w) => ({ pinyinBaseNumeric: toPinyinNumeric(w.pinyin).split(' ')[0] ?? '', word: w })),
    );
    if (picked) {
      const w = (picked.candidate as { word: (typeof candidates)[number] }).word;
      return { pinyin: w.pinyin, zhuyin: w.zhuyin, confidence: picked.confidence };
    }
  }

  // Homograph phrase with no specific rule: prefer the highest-frequency
  // sense (lowest freqRank), but mark it low-confidence since we didn't
  // actually disambiguate using context.
  const sorted = [...candidates].sort((a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity));
  const w = sorted[0]!;
  return { pinyin: w.pinyin, zhuyin: w.zhuyin, confidence: 'low' };
}
