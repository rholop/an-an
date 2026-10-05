import type { Span } from './types.js';

const TERMINATORS = new Set(['。', '！', '？', '!', '?', '\n', '；']);

/** Splits free text into sentence spans [start, end), each including its
 * trailing terminator. Whitespace-only stretches are skipped. */
export function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!TERMINATORS.has(text[i]!)) continue;
    // swallow a run of terminators / closing quotes ("？！」")
    let end = i + 1;
    while (end < text.length && (TERMINATORS.has(text[end]!) || '」』”’）)'.includes(text[end]!)))
      end++;
    if (text.slice(start, end).trim()) spans.push([start, end]);
    start = end;
    i = end - 1;
  }
  if (start < text.length && text.slice(start).trim()) spans.push([start, text.length]);
  return spans;
}

/** The smallest run of whole sentences covering `span` (a span that crosses
 * a sentence boundary pulls in every sentence it touches), trimmed of
 * leading/trailing whitespace. */
export function sentenceAround(text: string, span: Span): Span {
  const touching = splitReviewSentences(text).filter(([s, e]) => s < span[1] && span[0] < e);
  const start = Math.min(span[0], ...touching.map(([s]) => s));
  const end = Math.max(span[1], ...touching.map(([, e]) => e));
  let s = start;
  let e = end;
  while (s < span[0] && /\s/.test(text[s]!)) s++;
  while (e > span[1] && /\s/.test(text[e - 1]!)) e--;
  return [s, e];
}

const OPEN_QUOTES = new Set(['「', '『', '“', '‘']);
const CLOSE_QUOTES = new Set(['」', '』', '”', '’']);
const REVIEW_TERMINATORS = new Set(['。', '！', '？', '!', '?', '；']);

/** Phase 17 Part A: sentence splitting for the review call. Splits on 。！？
 * and line breaks, keeping a quotation together: a 。 inside 「…」 does not
 * end the sentence. Spans are trimmed of whitespace and skip empty stretches. */
export function splitReviewSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let depth = 0;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s]!)) s++;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    if (e > s) spans.push([s, e]);
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      push(i);
      start = i + 1;
      depth = 0;
      continue;
    }
    if (OPEN_QUOTES.has(ch)) depth++;
    else if (CLOSE_QUOTES.has(ch)) depth = Math.max(0, depth - 1);
    const endsHere = REVIEW_TERMINATORS.has(ch) && depth === 0;
    // a quote that closes straight after a terminator ends the sentence too
    const closesAfterTerminator =
      CLOSE_QUOTES.has(ch) && depth === 0 && i > 0 && REVIEW_TERMINATORS.has(text[i - 1]!);
    if (!endsHere && !closesAfterTerminator) continue;
    let end = i + 1;
    while (
      end < text.length &&
      (REVIEW_TERMINATORS.has(text[end]!) || (depth === 0 && CLOSE_QUOTES.has(text[end]!)))
    )
      end++;
    push(end);
    i = end - 1;
  }
  push(text.length);
  return spans;
}
