import { useMemo } from 'react';
import type { Lexicon, Word } from '@anan/core';
import { annotate, annotateWord } from '../lib/annotate.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { useSetting } from '../lib/useSetting.js';
import { AnnotatedText, type AnnotationScript } from './AnnotatedText.js';

/** The learner's chosen reading script (pinyin / zhuyin / both), shared with
 * the reader. Read ONCE per page and pass it down — many tiles must not each
 * hit the database. */
export function useReadingScript(): AnnotationScript {
  const [script] = useSetting<AnnotationScript>('readerScript', 'pinyin');
  return script;
}

/**
 * Chinese shown outside a sentence view (a garden tile, a journal prompt, a
 * correction): the reading is ALWAYS on screen — never hover-only, never off —
 * and every word has a hover definition and a tap/click popover. It is
 * deliberately not subject to the reader's mode setting.
 */
export function AnnotatedInline({
  text,
  lexicon,
  script,
  textbook,
}: {
  text: string;
  lexicon: Lexicon;
  script: AnnotationScript;
  /** Phase 12: textbook content — show the book's own sense of each word first. */
  textbook?: boolean;
}) {
  const { level } = useCurrentLevel();
  const tokens = useMemo(
    () => annotate(text, lexicon, undefined, { textbook }),
    [text, lexicon, textbook],
  );
  return (
    <AnnotatedText inline tokens={tokens} mode="always" script={script} currentLevel={level} />
  );
}

/** One specific lexicon entry (so a tile shows ITS reading and sense, not
 * whichever sense the spelling resolves to). */
export function AnnotatedWord({
  word,
  script,
  textbook,
}: {
  word: Word;
  script: AnnotationScript;
  textbook?: boolean;
}) {
  const { level } = useCurrentLevel();
  const tokens = useMemo(() => [annotateWord(word, { textbook })], [word, textbook]);
  return (
    <AnnotatedText inline tokens={tokens} mode="always" script={script} currentLevel={level} />
  );
}
