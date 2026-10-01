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
  const touching = splitSentences(text).filter(([s, e]) => s < span[1] && span[0] < e);
  const start = Math.min(span[0], ...touching.map(([s]) => s));
  const end = Math.max(span[1], ...touching.map(([, e]) => e));
  let s = start;
  let e = end;
  while (s < span[0] && /\s/.test(text[s]!)) s++;
  while (e > span[1] && /\s/.test(text[e - 1]!)) e--;
  return [s, e];
}
