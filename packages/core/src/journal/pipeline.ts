import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import type { Level } from '../types.js';
import { buildSentenceItems, type BuildItemsDeps, type DroppedItem } from './buildItems.js';
import { splitReviewSentences } from './sentences.js';
import { extractBrackets } from './bracket.js';
import type { ErrorItem, ModelSentenceReview, ProviderName } from './types.js';
import {
  sentenceKey,
  verifyCorrected,
  type JournalLLM,
  type SentenceCache,
  type VerifiedSentence,
} from './verifyCorrected.js';

const MAX_SENTENCE_CHARS = 300;
export const MAX_REVIEW_SENTENCES = 40;

export interface PreparedSentence {
  /** Position in the entry's sentence list (stable: item ids use it). */
  index: number;
  start: number;
  end: number;
  original: string;
}

/**
 * Part A: sentence splitting is done by code before the call. The model reviews
 * this numbered list, so `original` always equals the entry's own text.
 * Sentences with no Chinese, an unresolved `[English gap]`, or too long to
 * review are left out (they never become items).
 */
export function prepareSentences(text: string): PreparedSentence[] {
  const out: PreparedSentence[] = [];
  splitReviewSentences(text).forEach(([start, end], index) => {
    const original = text.slice(start, end);
    if (!/[一-鿿]/.test(original)) return;
    if (extractBrackets(original).length > 0 || original.length > MAX_SENTENCE_CHARS) return;
    out.push({ index, start, end, original });
  });
  return out.slice(0, MAX_REVIEW_SENTENCES);
}

/** What was stored from the single review call, per sentence. */
export interface RawSentenceReview extends PreparedSentence {
  /** Absent when the model returned nothing usable for this number. */
  review?: ModelSentenceReview;
  servedBy?: ProviderName;
}

/** Joins the model's `sentences` to the prepared list by the number it echoed.
 * `original` always comes from code; an out-of-range or repeated number is dropped. */
export function attachModelReviews(
  prepared: readonly PreparedSentence[],
  modelSentences: readonly ModelSentenceReview[] | undefined,
  servedBy?: ProviderName,
): RawSentenceReview[] {
  const position = new Map(prepared.map((p, i) => [i, p]));
  const byPosition = new Map<number, ModelSentenceReview>();
  for (const m of modelSentences ?? []) {
    if (position.has(m.index) && !byPosition.has(m.index)) byPosition.set(m.index, m);
  }
  return prepared.map((p, i) => ({ ...p, review: byPosition.get(i), servedBy }));
}

export interface EntryPipelineDeps {
  lexicon: Lexicon;
  llm: JournalLLM;
  protectedTerms: readonly string[];
  learnerLevel: Level;
  cache?: SentenceCache;
  now: Date;
}

export interface VerifiedSentenceRef extends VerifiedSentence {
  /** Index in the entry's sentence list. */
  index: number;
}

export interface VerifyEntryResult {
  sentences: VerifiedSentenceRef[];
  /** Sentences that could not be checked yet (no review, or the checker was
   * unreachable). They are retried later; nothing is shown from them. */
  pending: RawSentenceReview[];
}

/**
 * Part B for every sentence of an entry, one at a time, using the cache. A
 * network failure leaves that sentence pending instead of failing the entry.
 */
export async function verifyEntrySentences(
  deps: EntryPipelineDeps,
  raws: readonly RawSentenceReview[],
): Promise<VerifyEntryResult> {
  const sentences: VerifiedSentenceRef[] = [];
  const pending: RawSentenceReview[] = [];
  for (const raw of raws) {
    const key = sentenceKey(raw.original, deps.protectedTerms);
    const hit = await deps.cache?.get(key);
    if (hit) {
      sentences.push({ ...hit, index: raw.index, start: raw.start, end: raw.end });
      continue;
    }
    if (!raw.review) {
      pending.push(raw);
      continue;
    }
    try {
      const verified = await verifyCorrected(deps, {
        original: raw.original,
        start: raw.start,
        end: raw.end,
        review: raw.review,
        servedBy: raw.servedBy,
        now: deps.now,
      });
      await deps.cache?.set(key, verified);
      sentences.push({ ...verified, index: raw.index });
    } catch {
      pending.push(raw);
    }
  }
  return { sentences, pending };
}

export interface BuildEntryItemsResult {
  items: ErrorItem[];
  dropped: DroppedItem[];
}

/** Parts C + the solver test for every verified sentence of an entry. A
 * network failure while building leaves that sentence without items for now
 * (reported in `failed` so the caller can retry later). */
export async function buildEntryItems(
  deps: BuildItemsDeps,
  entryId: string,
  sentences: readonly VerifiedSentenceRef[],
): Promise<BuildEntryItemsResult & { failed: number[] }> {
  const items: ErrorItem[] = [];
  const dropped: DroppedItem[] = [];
  const failed: number[] = [];
  for (const s of sentences) {
    try {
      const built = await buildSentenceItems(deps, entryId, s.index, s);
      items.push(...built.items);
      dropped.push(...built.dropped);
    } catch {
      failed.push(s.index);
    }
  }
  return { items, dropped, failed };
}

/** Part E: a sentence is a plain cloze source only if it had no edits (and was
 * verified), or via its verified corrected version. */
export function clozeSourceSentences(
  sentences: readonly VerifiedSentence[],
): { zh: string; at: Date }[] {
  return sentences
    .filter((s) => s.status === 'verified')
    .map((s) => ({ zh: s.corrected, at: s.checkedAt }))
    .filter((s) => [...s.zh].length >= 4);
}

/** Names the learner may use in a sentence that aren't in the lexicon: runs of
 * unknown Han characters that appear in at least `minEntries` entries. A
 * suggestion for the protected-terms setting, never applied automatically. */
export function suggestProtectedTerms(
  texts: readonly string[],
  lexicon: Lexicon,
  minEntries = 2,
): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set<string>();
    let run = '';
    const flush = () => {
      if (run.length >= 2) seen.add(run);
      run = '';
    };
    for (const t of segment(text, lexicon)) {
      if (t.kind === 'unknown') run += t.text;
      else flush();
    }
    flush();
    for (const r of seen) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minEntries)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}
