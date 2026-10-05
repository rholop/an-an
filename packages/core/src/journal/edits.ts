import type { Lexicon } from '../lexicon.js';
import { segment, type Token } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import type { ItemRef } from '../types.js';
import type { EditKind, SentenceEdit, Span } from './types.js';

/** One change between the learner's sentence and the corrected one. Positions
 * are character offsets found by code (never taken from the model). */
export interface ResolvedEdit {
  /** [start, end) in the original; start === end for an insertion. */
  start: number;
  end: number;
  /** [start, end) in the corrected sentence; start === end for a deletion. */
  cStart: number;
  cEnd: number;
  before: string;
  after: string;
  contextBefore: string;
  kind: EditKind;
  pattern?: string;
  itemRef?: ItemRef;
  explanationEn: string;
}

export type EditShape = 'insertion' | 'deletion' | 'replacement';

export function editShape(e: Pick<ResolvedEdit, 'before' | 'after'>): EditShape {
  if (e.before === '') return 'insertion';
  if (e.after === '') return 'deletion';
  return 'replacement';
}

interface Located {
  start: number;
  end: number;
  edit: SentenceEdit;
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === '') return found;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1))
    found.push(i);
  return found;
}

/** Finds one model edit in `original` by searching for `contextBefore + before`.
 * Several matches: the first one at/after `minStart`. Returns null when the
 * edit cannot be placed. Model-supplied offsets are never used. */
export function locateEdit(original: string, edit: SentenceEdit, minStart = 0): Located | null {
  const ctx = edit.contextBefore ?? '';
  if (edit.before !== '') {
    let starts = occurrences(original, ctx + edit.before).map((i) => i + ctx.length);
    // a wrong context is the commonest model slip; fall back to the bare text
    if (starts.length === 0) starts = occurrences(original, edit.before);
    const at = starts.find((s) => s >= minStart);
    return at === undefined ? null : { start: at, end: at + edit.before.length, edit };
  }
  if (edit.after === '') return null;
  if (ctx === '') return minStart === 0 ? { start: 0, end: 0, edit } : null;
  const at = occurrences(original, ctx)
    .map((i) => i + ctx.length)
    .find((s) => s >= minStart);
  return at === undefined ? null : { start: at, end: at, edit };
}

/** Applies located edits (any order, must not overlap). Null if they overlap. */
function applyLocated(original: string, located: Located[]): string | null {
  const sorted = [...located].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  for (const l of sorted) {
    if (l.start < cursor) return null;
    out += original.slice(cursor, l.start) + l.edit.after;
    cursor = l.end;
  }
  return out + original.slice(cursor);
}

/** Part A's gate: do the model's edits, found by search, rebuild `corrected`
 * from `original` exactly? Returns the located edits when they do. */
export function locateModelEdits(
  original: string,
  corrected: string,
  edits: readonly SentenceEdit[],
): Located[] | null {
  if (edits.length === 0) return null;
  const located: Located[] = [];
  let minStart = 0;
  // Earliest-first: an edit that appears first in the sentence is placed first.
  for (const edit of edits) {
    const l = locateEdit(original, edit, 0);
    if (!l) return null;
    located.push(l);
  }
  located.sort((a, b) => a.start - b.start);
  // re-place duplicates so two identical edits don't land on one spot
  for (let i = 1; i < located.length; i++) {
    const prev = located[i - 1]!;
    if (located[i]!.start < prev.end || (located[i]!.start === prev.start && prev.end === prev.start)) {
      minStart = prev.end;
      const again = locateEdit(original, located[i]!.edit, minStart);
      if (!again) return null;
      located[i] = again;
    }
  }
  return applyLocated(original, located) === corrected ? located : null;
}

interface Hunk {
  start: number;
  end: number;
  cStart: number;
  cEnd: number;
}

const joined = (tokens: readonly Token[]) => tokens.map((t) => t.text).join('');

/** Token-level LCS diff of `original` against `corrected`, one hunk per run of
 * differing tokens. Smallest-possible edits: an inserted 是 is an insertion,
 * not the replacement of its neighbour by 是+neighbour. Null if the tokens do
 * not cover the strings (they always should). */
export function diffHunks(original: string, corrected: string, lexicon: Lexicon): Hunk[] | null {
  const a = segment(original, lexicon);
  const b = segment(corrected, lexicon);
  if (joined(a) !== original || joined(b) !== corrected) return null;
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i]!.text === b[j]!.text
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      close();
      i++;
      j++;
      continue;
    }
    const pos = i < n ? a[i]!.start : original.length;
    const cpos = j < m ? b[j]!.start : corrected.length;
    open ??= { start: pos, end: pos, cStart: cpos, cEnd: cpos };
    // delete from the original first when that keeps the LCS, else insert
    if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      open.end = a[i]!.end;
      i++;
    } else {
      open.cEnd = b[j]!.end;
      j++;
    }
  }
  close();
  // the hunks must rebuild `corrected` exactly
  let rebuilt = '';
  let cursor = 0;
  for (const h of hunks) {
    rebuilt += original.slice(cursor, h.start) + corrected.slice(h.cStart, h.cEnd);
    cursor = h.end;
  }
  rebuilt += original.slice(cursor);
  return rebuilt === corrected ? hunks : null;
}

const PARTICLES = new Set([...'了的過嗎吧呢啊著喔呀']);
const PUNCT_ONLY = /^[\s，。、！？,.!?；;：:「」『』"'（）()…—]*$/;

export function isPunctuationOnly(text: string): boolean {
  return PUNCT_ONLY.test(text);
}

function sortedChars(s: string): string {
  return [...s.replace(/[\s，。、！？,.!?；;：:]/g, '')].sort().join('');
}

/** Guess an edit's kind when the model's edit couldn't be used. */
export function inferEditKind(before: string, after: string): EditKind {
  if (before === '') return PARTICLES.has(after) ? 'particle' : 'missing_word';
  if (after === '') return PARTICLES.has(before) ? 'particle' : 'extra_word';
  if (checkTaiwanness(before).mainlandTerms.length > 0) return 'mainland_style';
  if (PARTICLES.has(before) || PARTICLES.has(after)) return 'particle';
  return 'wrong_word';
}

function genericExplanation(kind: EditKind, before: string, after: string): string {
  switch (kind) {
    case 'missing_word':
      return `A word is missing here: “${after}”.`;
    case 'extra_word':
      return `“${before}” isn't needed here.`;
    case 'particle':
      return before === ''
        ? `The particle “${after}” is needed here.`
        : after === ''
          ? `The particle “${before}” isn't needed here.`
          : `Taiwanese speakers use “${after}” here, not “${before}”.`;
    case 'mainland_style':
      return `Taiwanese speakers say “${after}”, not “${before}”.`;
    case 'word_order':
      return 'The words are in a different order in natural Chinese.';
    default:
      return `Taiwanese speakers say “${after}” here instead of “${before}”.`;
  }
}

export interface ResolvedEdits {
  edits: ResolvedEdit[];
  /** Whether the model's own edits rebuilt `corrected` (their notes were kept). */
  modelEditsUsable: boolean;
}

/**
 * Part A + C. Always returns the smallest token-level edits between `original`
 * and `corrected` (from the diff). When the model's own edits reproduce
 * `corrected` exactly, their kind/pattern/explanation are carried onto the
 * diff edit they overlap; when they don't, the whole set is discarded and
 * the notes are generic. Null when even the diff can't rebuild the sentence.
 */
export function resolveEdits(
  original: string,
  corrected: string,
  modelEdits: readonly SentenceEdit[],
  lexicon: Lexicon,
): ResolvedEdits | null {
  if (original === corrected) return { edits: [], modelEditsUsable: true };
  const hunks = diffHunks(original, corrected, lexicon);
  if (!hunks || hunks.length === 0) return null;
  const located = locateModelEdits(original, corrected, modelEdits);

  const edits: ResolvedEdit[] = hunks.map((h) => {
    const before = original.slice(h.start, h.end);
    const after = corrected.slice(h.cStart, h.cEnd);
    const match = located?.find(
      (l) =>
        (l.start < h.end && h.start < l.end) ||
        (h.start === h.end && l.start <= h.start && h.start <= l.end) ||
        (l.start === l.end && h.start <= l.start && l.start <= h.end),
    );
    const kind = match?.edit.kind ?? inferEditKind(before, after);
    return {
      ...h,
      before,
      after,
      contextBefore: original.slice(Math.max(0, h.start - 3), h.start),
      kind,
      pattern: match?.edit.pattern,
      itemRef: match?.edit.itemRef,
      explanationEn: match?.edit.explanationEn.trim() || genericExplanation(kind, before, after),
    };
  });

  // Hunks that only move the same characters around are one word-order change.
  const changed = edits.filter((e) => !isPunctuationOnly(e.before + e.after));
  if (
    changed.length >= 2 &&
    sortedChars(changed.map((e) => e.before).join('')) ===
      sortedChars(changed.map((e) => e.after).join(''))
  ) {
    for (const e of changed) {
      e.kind = 'word_order';
      e.explanationEn =
        located?.find((l) => l.edit.kind === 'word_order')?.edit.explanationEn.trim() ||
        genericExplanation('word_order', e.before, e.after);
    }
  }
  return { edits, modelEditsUsable: located !== null };
}

/** Applies resolved edits back onto `original` (a self-check for callers/tests). */
export function applyResolvedEdits(original: string, edits: readonly ResolvedEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const e of [...edits].sort((x, y) => x.start - y.start)) {
    out += original.slice(cursor, e.start) + e.after;
    cursor = e.end;
  }
  return out + original.slice(cursor);
}

export const spanOf = (e: Pick<ResolvedEdit, 'start' | 'end'>): Span => [e.start, e.end];
