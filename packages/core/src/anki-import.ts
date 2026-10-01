import type { Lexicon } from './lexicon.js';
import type { Level, Word } from './types.js';

/**
 * Parses an Anki "Notes in Plain Text" export: strips Anki's leading
 * `#`-prefixed metadata lines (`#separator:tab`, `#html:true`, ...), then
 * splits on tab if any line contains one, else comma — with minimal CSV
 * quote handling (a field wrapped in "..." may contain the delimiter or
 * escaped "" quotes). Pure text in, rows out; no file I/O here.
 */
export function parseDelimitedText(raw: string): string[][] {
  const lines = raw.split(/\r\n|\n|\r/).filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return [];

  const delimiter = lines.some((l) => l.includes('\t')) ? '\t' : ',';
  return lines.map((line) => parseDelimitedLine(line, delimiter));
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  if (!line.includes('"')) return line.split(delimiter);

  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

export type AnkiMatchStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface AnkiMatchResult {
  row: string[];
  headword: string;
  status: AnkiMatchStatus;
  /** Resolved word for matched/ambiguous rows (for ambiguous: the
   * lowest-freqRank candidate, auto-picked but still flagged ambiguous so a
   * human can review). */
  word?: Word;
  /** All candidates sharing this headword, present only when ambiguous. */
  candidates?: Word[];
}

/** Matches each row's headword column against the lexicon, by headword OR
 * any of its variants (CLAUDE.md phase-2 §6: "including variants"). */
export function matchAnkiRows(rows: string[][], headwordColumn: number, lexicon: Lexicon): AnkiMatchResult[] {
  return rows.map((row) => {
    const headword = (row[headwordColumn] ?? '').trim();
    if (!headword) return { row, headword, status: 'unmatched' as const };

    const candidates = lexicon.lookup(headword);
    if (candidates.length === 0) return { row, headword, status: 'unmatched' as const };
    if (candidates.length === 1) return { row, headword, status: 'matched' as const, word: candidates[0] };

    const best = [...candidates].sort((a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity))[0];
    return { row, headword, status: 'ambiguous' as const, word: best, candidates };
  });
}

export interface AnkiMatchSummary {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
}

export function summarizeAnkiMatch(results: AnkiMatchResult[]): AnkiMatchSummary {
  const summary = { total: results.length, matched: 0, ambiguous: 0, unmatched: 0 };
  for (const r of results) {
    if (r.status === 'matched') summary.matched++;
    else if (r.status === 'ambiguous') summary.ambiguous++;
    else summary.unmatched++;
  }
  return summary;
}

// FNV-1a — a small, dependency-free deterministic hash (core can't import
// node:crypto; see the ESLint core-purity rule), used to mint stable ids for
// user-added custom words from the same headword+pinyin.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Builds a `source: 'custom'` Word for an unmatched Anki row the user
 * chooses to add. Pinyin/gloss are whatever the user had in their deck (or
 * blank) — unlike the Phase 1 pipeline, there's no MOE cross-check here. */
export function buildCustomWord(headword: string, pinyin = '', glossEn = '', level: Level | null = null): Word {
  return {
    id: `custom-${fnv1a(`${headword}|${pinyin}`)}`,
    headword,
    variants: [],
    pos: [],
    level,
    source: 'custom',
    pinyin,
    pinyinNumeric: '',
    zhuyin: '',
    glossEn,
    chars: [...headword],
    tags: ['anki-import'],
  };
}
