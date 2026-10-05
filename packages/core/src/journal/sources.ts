import type { JournalSentenceSource } from '../cloze/source.js';
import { splitReviewSentences } from './sentences.js';
import type { Span } from './types.js';

/**
 * Phase 5 §9: the learner's own sentences as a cloze source (fills Phase 4's
 * stub). A sentence is only offered if it overlaps no issue the review
 * raised (flagged or not — a doubtful correction isn't proof the sentence
 * is right) and holds no `[English gap]`, so a cloze never re-teaches a
 * mistake. An entry with no review yet (`null`) yields nothing.
 */
export function journalSentencesFromEntry(
  text: string,
  issueSpans: readonly Span[] | null,
  at: Date,
): JournalSentenceSource[] {
  if (issueSpans === null) return [];
  return splitReviewSentences(text)
    .filter(([s, e]) => !issueSpans.some(([a, b]) => a < e && s < b))
    .map(([s, e]) => text.slice(s, e).trim())
    .filter((zh) => zh.length >= 4 && !/[[［\]］]/.test(zh))
    .map((zh) => ({ zh, at }));
}
