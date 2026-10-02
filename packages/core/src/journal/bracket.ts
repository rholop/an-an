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

/** Phase 5 §2 gap capture: `今天我去 [gym]` — English in square brackets
 * (ASCII or full-width) marks a word the learner couldn't produce. */
export function extractBrackets(text: string): BracketGap[] {
  const gaps: BracketGap[] = [];
  const re = /[[［]([^[\]［］]+)[\]］]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const en = m[1]!.trim();
    if (en) gaps.push({ en, start: m.index, end: m.index + m[0].length });
  }
  return gaps;
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

/** Replaces each `[en]` with `zh` (or leaves it if there's no translation),
 * for the "shown inline" display. `translations` is keyed by `en`. */
export function renderBracketsInline(
  text: string,
  translations: ReadonlyMap<string, string>,
): string {
  return text.replace(
    /[[［]([^[\]［］]+)[\]］]/g,
    (whole, en: string) => translations.get(en.trim()) ?? whole,
  );
}
