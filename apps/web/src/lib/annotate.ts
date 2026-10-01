import { Lexicon, readingDisplay, resolveReading, segment, type Level, type SkillCard, type Token } from '@anan/core';
import type { AnnotatedToken } from '../components/AnnotatedText.js';

/** Segments `text` and resolves a reading/level/gloss for every token,
 * matching the Word entry resolveReading actually picked (not just the
 * first lexicon sense) so the popover's gloss/level line up with the shown
 * reading. */
export function annotate(text: string, lexicon: Lexicon): AnnotatedToken[] {
  const tokens = segment(text, lexicon);
  return tokens.map((token, i) => {
    const reading = resolveReading(token, { prevToken: tokens[i - 1], nextToken: tokens[i + 1] }, lexicon);
    let level: Level | null = null;
    let gloss = '';
    let wordId: string | undefined;
    if (token.kind === 'word') {
      const candidates = lexicon.lookup(token.text);
      const matched = candidates.find((w) => w.pinyin === reading.pinyin) ?? candidates[0];
      level = matched?.level ?? null;
      gloss = matched?.glossEn ?? '';
      wordId = matched?.id;
    }
    return { token, reading, level, gloss, wordId };
  });
}

export function tokensOnly(annotated: AnnotatedToken[]): Token[] {
  return annotated.map((a) => a.token);
}

/** Attaches Phase 2's pinyin-fading decision (readingDisplay()) to each
 * token, keyed by the recognition-skill card for its wordId. Words with no
 * card yet (never seen) are left without a readingMode, which AnnotatedText
 * treats as 'shown' — the safe default for something the learner hasn't
 * met. */
export function withReadingDisplay(
  annotated: AnnotatedToken[],
  recognitionCardsByWordId: ReadonlyMap<string, SkillCard>,
): AnnotatedToken[] {
  return annotated.map((at) => {
    if (!at.wordId) return at;
    const card = recognitionCardsByWordId.get(at.wordId);
    if (!card) return at;
    return { ...at, readingMode: readingDisplay(card) };
  });
}
