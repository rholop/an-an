import type { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { LEVEL_IDS } from '../levels.config.js';

const LEVEL_ORDER = LEVEL_IDS;

export interface BracketGap {
  /** The English inside the brackets, trimmed. */
  en: string;
  /** [start, end) of the whole `[...]` including the brackets. */
  start: number;
  end: number;
}

/** Phase 31 Part F: every bracket a Chinese keyboard produces opens or closes a gap, and pairs
 * may be mixed (`[nice］`, `【nice]`). This is the one place the bracket characters are listed. */
export const GAP_OPEN_BRACKETS = '[［【〖〔';
export const GAP_CLOSE_BRACKETS = ']］】〗〕';
const ALL = escapeClass(`${GAP_OPEN_BRACKETS}${GAP_CLOSE_BRACKETS}`);
/** Any gap bracket character (for "does this sentence still hold a gap?" tests). */
export const ANY_GAP_BRACKET = new RegExp(`[${ALL}]`);
/** A gap holds at least one Latin letter, so Chinese in 【】 (a title, an aside) is never a gap. */
const LATIN = /[A-Za-z]/;

/** Phase 5 §2 gap capture: `今天我去 [gym]`, `今天我去【gym】`. English inside any pair of gap
 * brackets marks a word the learner couldn't produce. A pair sitting inside another pair (nested)
 * and an unclosed bracket stay plain text. */
export function extractBrackets(text: string): BracketGap[] {
  const re = new RegExp(`[${escapeClass(GAP_OPEN_BRACKETS)}]([^${ALL}]*)[${escapeClass(GAP_CLOSE_BRACKETS)}]`, 'g');
  const isOpen = (c: string) => GAP_OPEN_BRACKETS.includes(c);
  const isClose = (c: string) => GAP_CLOSE_BRACKETS.includes(c);
  const gaps: BracketGap[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const en = m[1]!.trim();
    if (!en || !LATIN.test(en)) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (enclosed(text, start, end, isOpen, isClose)) continue;
    gaps.push({ en, start, end });
  }
  return gaps;
}

function escapeClass(chars: string): string {
  return chars.replace(/[[\]]/g, (c) => `\\${c}`);
}

/** Is [start, end) inside an outer pair: an open bracket before it with no close in between, and a
 * close after it with no open in between? */
function enclosed(
  text: string,
  start: number,
  end: number,
  isOpen: (c: string) => boolean,
  isClose: (c: string) => boolean,
): boolean {
  let before = false;
  for (let i = start - 1; i >= 0; i--) {
    const c = text[i]!;
    if (isClose(c)) break;
    if (isOpen(c)) {
      before = true;
      break;
    }
  }
  if (!before) return false;
  for (let i = end; i < text.length; i++) {
    const c = text[i]!;
    if (isOpen(c)) return false;
    if (isClose(c)) return true;
  }
  return false;
}

/** The text with every gap replaced (`summarizeLevels`, character counts). */
export function replaceGaps(text: string, replace: (gap: BracketGap) => string): string {
  let out = '';
  let cursor = 0;
  for (const g of extractBrackets(text)) {
    out += text.slice(cursor, g.start) + replace(g);
    cursor = g.end;
  }
  return out + text.slice(cursor);
}

function glossParts(gloss: string): string[] {
  return gloss
    .toLowerCase()
    .split(/[;,/]/)
    .map((p) =>
      p
        .replace(/^to\s+/, '')
        .replace(/\(.*?\)/g, '')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Lexicon-first translation of a bracketed English word (phase doc §2).
 * Matches whole gloss parts only ("gym" matches "gym; gymnasium" but not
 * "gymnastics"), preferring the lowest level and then the most frequent
 * word. Returns null when nothing matches, in which case the caller falls
 * back to the LLM's bracket translation.
 */
export function lookupBracketInLexicon(en: string, lexicon: Lexicon): Word | null {
  const needle = en
    .toLowerCase()
    .replace(/^to\s+/, '')
    .trim();
  if (!needle) return null;
  const matches = lexicon
    .allWords()
    .filter((w) => w.source !== 'custom' && glossParts(w.glossEn).includes(needle));
  if (matches.length === 0) return null;
  const rank = (w: Word) => (w.level ? LEVEL_ORDER.indexOf(w.level) : LEVEL_ORDER.length);
  matches.sort((a, b) => rank(a) - rank(b) || (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity));
  return matches[0]!;
}

/** Replaces each gap with `zh` (or leaves it if there's no translation), for the "shown inline"
 * display. `translations` is keyed by `en`. */
export function renderBracketsInline(
  text: string,
  translations: ReadonlyMap<string, string>,
): string {
  return replaceGaps(text, (g) => translations.get(g.en) ?? text.slice(g.start, g.end));
}
