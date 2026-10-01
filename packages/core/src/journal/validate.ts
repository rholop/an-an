import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import type { ItemRef } from '../types.js';
import {
  JournalReviewSchema,
  type JournalBracket,
  type JournalIssue,
  type JournalReview,
  type Span,
  type UsedWell,
} from './types.js';

export const MAX_JOURNAL_ISSUES = 3;

export interface ValidateJournalOptions {
  lexicon: Lexicon;
  /** The learner's original text — spans index into this. */
  text: string;
  maxIssues?: number;
  /** Top recent error patterns; issues matching one outrank other issues of
   * the same type when the cap bites. */
  recurringPatterns?: readonly string[];
  /** [start, end) ranges of `[English]` gaps — not the learner's Chinese, so
   * no issue may point into them. */
  bracketRanges?: readonly Span[];
}

export interface Rejection {
  what: 'issue' | 'used_well' | 'bracket' | 'rewrite' | 'cap' | 'overlap';
  reason: string;
  detail?: string;
}

export interface ValidatedJournalReview {
  review: JournalReview;
  rejected: Rejection[];
}

export class JournalReviewShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalReviewShapeError';
  }
}

const TYPE_RANK: Record<JournalIssue['type'], number> = {
  error: 0,
  mainland_style: 1,
  unnatural: 2,
};
const CONFIDENCE_RANK: Record<JournalIssue['confidence'], number> = { high: 0, medium: 1, low: 2 };

function spanInRange(span: Span, length: number): boolean {
  return (
    Number.isInteger(span[0]) &&
    Number.isInteger(span[1]) &&
    span[0] >= 0 &&
    span[1] > span[0] &&
    span[1] <= length
  );
}

function overlaps(a: Span, b: Span): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** The LLM can't know our word ids, so it may name a word by headword — accept
 * either, normalise to a real lexicon id, and drop anything unresolvable. */
export function resolveItemRef(ref: ItemRef | undefined, lexicon: Lexicon): ItemRef | undefined {
  if (!ref) return undefined;
  if (ref.kind === 'grammar') return lexicon.grammarItemById(ref.id) ? ref : undefined;
  const word = lexicon.byId(ref.id) ?? lexicon.lookup(ref.id)[0];
  return word ? { kind: 'word', id: word.id } : undefined;
}

/** When the model gave no usable itemRef, infer the word an issue is about:
 * the single word the correction introduces that the original span lacked. */
function inferWordFromCorrection(
  original: string,
  correction: string,
  lexicon: Lexicon,
): ItemRef | undefined {
  const originalTexts = new Set(segment(original, lexicon).map((t) => t.text));
  const fresh = segment(correction, lexicon).filter(
    (t) => t.kind === 'word' && !originalTexts.has(t.text),
  );
  if (fresh.length !== 1) return undefined;
  const word = lexicon.lookup(fresh[0]!.text)[0];
  return word ? { kind: 'word', id: word.id } : undefined;
}

function rankIssues(issues: JournalIssue[], recurring: ReadonlySet<string>): JournalIssue[] {
  const isRecurring = (i: JournalIssue) => (i.pattern && recurring.has(i.pattern) ? 0 : 1);
  return [...issues].sort(
    (a, b) =>
      TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
      isRecurring(a) - isRecurring(b) ||
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      a.span[0] - b.span[0],
  );
}

/**
 * Phase 5 §3: LLM output is data to validate, never trusted. Parses the raw
 * response, drops anything unsafe or nonsensical (out-of-range spans,
 * simplified/mainland corrections, spans inside `[gaps]`, no-op corrections,
 * overlapping spans), caps the survivors at `maxIssues` with errors
 * outranking style and recurring patterns first, and confirms `used_well`
 * items really occur in the text by re-segmenting it.
 */
export function validateJournalReview(
  raw: unknown,
  opts: ValidateJournalOptions,
): ValidatedJournalReview {
  const parsed = JournalReviewSchema.safeParse(raw);
  if (!parsed.success)
    throw new JournalReviewShapeError(
      `journal review has the wrong shape: ${parsed.error.message}`,
    );
  const { lexicon, text } = opts;
  const maxIssues = opts.maxIssues ?? MAX_JOURNAL_ISSUES;
  const rejected: Rejection[] = [];
  const bracketRanges = opts.bracketRanges ?? [];

  const candidates: JournalIssue[] = [];
  for (const issue of parsed.data.issues) {
    const reject = (reason: string) =>
      rejected.push({ what: 'issue', reason, detail: issue.correction });
    if (!spanInRange(issue.span, text.length)) {
      reject('span out of range');
      continue;
    }
    if (bracketRanges.some((r) => overlaps(r, issue.span))) {
      reject('span overlaps an English bracket gap');
      continue;
    }
    const original = text.slice(issue.span[0], issue.span[1]);
    const correction = issue.correction.trim();
    if (!correction || correction === original) {
      reject('correction is empty or identical to the original');
      continue;
    }
    if (!issue.explanationEn.trim()) {
      reject('missing explanation');
      continue;
    }
    const tw = checkTaiwanness(correction);
    if (!tw.isClean) {
      reject(
        tw.simplifiedChars.length > 0
          ? 'correction contains simplified characters'
          : 'correction uses mainland-style wording',
      );
      continue;
    }
    const itemRef =
      resolveItemRef(issue.itemRef, lexicon) ??
      inferWordFromCorrection(original, correction, lexicon);
    candidates.push({ ...issue, correction, itemRef });
  }

  const recurring = new Set(opts.recurringPatterns ?? []);
  const ranked = rankIssues(candidates, recurring);
  const kept: JournalIssue[] = [];
  for (const issue of ranked) {
    if (kept.some((k) => overlaps(k.span, issue.span))) {
      rejected.push({
        what: 'overlap',
        reason: 'overlaps a higher-priority issue',
        detail: issue.correction,
      });
      continue;
    }
    if (kept.length >= maxIssues) {
      rejected.push({
        what: 'cap',
        reason: `more than ${maxIssues} issues`,
        detail: issue.correction,
      });
      continue;
    }
    kept.push(issue);
  }
  kept.sort((a, b) => a.span[0] - b.span[0]);

  const tokens = segment(text, lexicon);
  const usedWell: UsedWell[] = [];
  const seenUsed = new Set<string>();
  for (const u of parsed.data.used_well) {
    const itemRef = resolveItemRef(u.itemRef, lexicon);
    const reject = (reason: string) =>
      rejected.push({ what: 'used_well', reason, detail: u.itemRef.id });
    if (!itemRef) {
      reject('unknown item');
      continue;
    }
    if (!spanInRange(u.span, text.length)) {
      reject('span out of range');
      continue;
    }
    if (
      kept.some((k) => overlaps(k.span, u.span)) ||
      bracketRanges.some((r) => overlaps(r, u.span))
    ) {
      reject('span overlaps an issue or gap');
      continue;
    }
    if (itemRef.kind === 'word') {
      const found = tokens.some(
        (t) =>
          t.kind === 'word' &&
          overlaps([t.start, t.end], u.span) &&
          lexicon.lookup(t.text).some((w) => w.id === itemRef.id),
      );
      if (!found) {
        reject('item does not appear in the text');
        continue;
      }
    }
    const key = `${itemRef.kind}:${itemRef.id}`;
    if (seenUsed.has(key)) continue;
    seenUsed.add(key);
    usedWell.push({ itemRef, span: u.span });
  }

  let naturalRewrite = parsed.data.natural_rewrite.trim();
  if (naturalRewrite && !checkTaiwanness(naturalRewrite).isClean) {
    rejected.push({
      what: 'rewrite',
      reason: 'natural rewrite is not clean Taiwan traditional Chinese',
    });
    naturalRewrite = '';
  }

  const brackets: JournalBracket[] = [];
  for (const b of parsed.data.brackets) {
    const zh = b.zh.trim();
    if (!zh || !checkTaiwanness(zh).isClean) {
      rejected.push({
        what: 'bracket',
        reason: 'translation empty or not Taiwan traditional',
        detail: b.en,
      });
      continue;
    }
    const byId = b.wordId ? lexicon.byId(b.wordId) : undefined;
    const word =
      byId && (byId.headword === zh || byId.variants.includes(zh)) ? byId : lexicon.lookup(zh)[0];
    brackets.push({ en: b.en, zh, wordId: word?.id });
  }

  return {
    review: { issues: kept, natural_rewrite: naturalRewrite, brackets, used_well: usedWell },
    rejected,
  };
}
