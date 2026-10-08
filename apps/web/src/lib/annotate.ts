import {
  homeLessonOfTags,
  Lexicon,
  readingDisplay,
  resolveReading,
  senseFor,
  segment,
  type Level,
  type Sense,
  type SkillCard,
  type Token,
  type Word,
} from '@anan/core';
import type { AnnotatedToken } from '../components/AnnotatedText.js';

/** Segments `text` and resolves a reading/level/gloss for every token,
 * matching the Word entry resolveReading actually picked (not just the
 * first lexicon sense) so the popover's gloss/level line up with the shown
 * reading. */
export function annotate(
  text: string,
  lexicon: Lexicon,
  /** Phase 7: sense ids the model chose per token text (chat turns). Only used
   * if the id is one of the word's real senses; otherwise context rules pick. */
  senseHints?: ReadonlyMap<string, string>,
  /** Phase 12: showing textbook content — a word's textbook sense (the book's
   * own gloss) is preferred over the dictionary's primary sense. */
  opts: { textbook?: boolean } = {},
): AnnotatedToken[] {
  const tokens = segment(text, lexicon);
  return tokens.map((token, i) => {
    const reading = resolveReading(
      token,
      { prevToken: tokens[i - 1], nextToken: tokens[i + 1] },
      lexicon,
    );
    let level: Level | null = null;
    let gloss = '';
    let wordId: string | undefined;
    let word: Word | undefined;
    let sense: Sense | undefined;
    if (token.kind === 'word') {
      const matched = lexicon.preferred(token.text, reading.pinyin);
      level = matched?.level ?? null;
      wordId = matched?.id;
      word = matched;
      // Phase 21: the one gloss rule (core `senseFor`).
      sense = matched
        ? senseFor(matched, {
            ...(senseHints?.get(token.text) ? { senseId: senseHints.get(token.text)! } : {}),
            prev: tokens[i - 1]?.text,
            next: tokens[i + 1]?.text,
            textbook: !!opts.textbook,
          })
        : undefined;
      gloss = sense?.glossEn ?? matched?.glossEn ?? '';
    }
    const textbookHome = word ? homeLessonOfTags(word.tags) : undefined;
    return { token, reading, level, gloss, wordId, word, sense, textbookHome };
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

/** One already-known lexicon entry as an annotated token (reading, level and
 * gloss taken from THAT entry, not re-derived from its spelling). For places
 * that show a specific word — a garden plant, a "try to use" word — where the
 * sense matters: 去 as the N1 verb must not turn into the L3 particle. */
export function annotateWord(word: Word, opts: { textbook?: boolean } = {}): AnnotatedToken {
  const length = [...word.headword].length;
  const sense = senseFor(word, opts.textbook === undefined ? {} : { textbook: opts.textbook });
  return {
    token: { text: word.headword, start: 0, end: length, kind: 'word' },
    reading: { pinyin: word.pinyin, zhuyin: word.zhuyin, confidence: 'high' },
    level: word.level,
    gloss: sense?.glossEn ?? word.glossEn,
    wordId: word.id,
    word,
    sense,
    textbookHome: homeLessonOfTags(word.tags),
  };
}
