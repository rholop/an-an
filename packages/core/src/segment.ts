import type { Lexicon } from './lexicon.js';

export type TokenKind = 'word' | 'number' | 'latin' | 'punct' | 'unknown';

export interface Token {
  text: string;
  start: number;
  end: number; // exclusive
  kind: TokenKind;
}

export interface HintToken {
  start: number;
  end: number;
}

export interface SegmentOptions {
  /** LLM-suggested token spans to reconcile against the lexicon (CLAUDE.md
   * §segment: "Accept optional hint tokens ... reconcile: keep a hint if
   * it's in the lexicon or whitelist, else re-segment that span"). */
  hints?: HintToken[];
  /** Spans accepted even though they aren't in the lexicon (e.g. a proper
   * noun an LLM introduced that hasn't been added as a supplement word yet). */
  whitelist?: Set<string>;
}

function isHanChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}
function isDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}
function isLatinLetter(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function classify(ch: string): TokenKind {
  const cp = ch.codePointAt(0)!;
  if (isHanChar(cp)) return 'word'; // provisional; refined by lexicon matching below
  if (isDigit(cp)) return 'number';
  if (isLatinLetter(cp)) return 'latin';
  return 'punct';
}

interface Run {
  text: string;
  start: number;
  kind: TokenKind;
}

/** Group the raw string into maximal runs of the same coarse character class. */
function toRuns(text: string): Run[] {
  const runs: Run[] = [];
  const chars = [...text];
  let offset = 0;
  let cur: Run | null = null;
  for (const ch of chars) {
    const kind = classify(ch);
    if (cur && cur.kind === kind) {
      cur.text += ch;
    } else {
      if (cur) runs.push(cur);
      cur = { text: ch, start: offset, kind };
    }
    offset += ch.length;
  }
  if (cur) runs.push(cur);
  return runs;
}

/** Forward maximum matching over a single Han-character run. */
function forwardMaxMatch(run: string, lexicon: Lexicon): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const chars = [...run];
  while (pos < chars.length) {
    const matches = lexicon.prefixesOf(run, pos);
    const best = matches[0]; // longest-match-first
    const len = best?.len ?? 1;
    tokens.push({
      text: chars.slice(pos, pos + len).join(''),
      start: pos,
      end: pos + len,
      kind: best ? 'word' : 'unknown',
    });
    pos += len;
  }
  return tokens;
}

/** Backward maximum matching over a single Han-character run. */
function backwardMaxMatch(run: string, lexicon: Lexicon): Token[] {
  const chars = [...run];
  const tokens: Token[] = [];
  let end = chars.length;
  while (end > 0) {
    let bestLen = 1;
    let found = false;
    const maxLen = Math.min(lexicon.maxHeadwordLength, end);
    for (let len = maxLen; len >= 1; len--) {
      const start = end - len;
      const span = chars.slice(start, end).join('');
      if (lexicon.lookup(span).length > 0) {
        bestLen = len;
        found = true;
        break;
      }
    }
    tokens.push({
      text: chars.slice(end - bestLen, end).join(''),
      start: end - bestLen,
      end,
      kind: found ? 'word' : 'unknown',
    });
    end -= bestLen;
  }
  return tokens.reverse();
}

function singleCharCount(tokens: Token[]): number {
  return tokens.filter((t) => [...t.text].length === 1).length;
}

/** Bidirectional maximum matching: run FMM and BMM, prefer fewer tokens, then
 * fewer single-character tokens, then FMM as a deterministic tiebreak. */
function segmentRun(run: string, lexicon: Lexicon): Token[] {
  const fmm = forwardMaxMatch(run, lexicon);
  const bmm = backwardMaxMatch(run, lexicon);
  if (fmm.length !== bmm.length) return fmm.length < bmm.length ? fmm : bmm;
  const fmmSingles = singleCharCount(fmm);
  const bmmSingles = singleCharCount(bmm);
  if (fmmSingles !== bmmSingles) return fmmSingles < bmmSingles ? fmm : bmm;
  return fmm;
}

function shiftTokens(tokens: Token[], offset: number): Token[] {
  return tokens.map((t) => ({ ...t, start: t.start + offset, end: t.end + offset }));
}

export function segment(text: string, lexicon: Lexicon, opts: SegmentOptions = {}): Token[] {
  const runs = toRuns(text);
  const tokens: Token[] = [];

  for (const run of runs) {
    if (run.kind !== 'word') {
      tokens.push({ text: run.text, start: run.start, end: run.start + run.text.length, kind: run.kind });
      continue;
    }

    const runStart = run.start;
    const runEnd = run.start + run.text.length;

    // Hints that fall fully inside this Han run and are accepted (either a
    // real lexicon entry or explicitly whitelisted).
    const acceptedHints = (opts.hints ?? [])
      .filter((h) => h.start >= runStart && h.end <= runEnd && h.end > h.start)
      .filter((h) => {
        const span = text.slice(h.start, h.end);
        return lexicon.lookup(span).length > 0 || opts.whitelist?.has(span);
      })
      .sort((a, b) => a.start - b.start)
      // drop overlapping hints defensively, keep first-seen
      .reduce<HintToken[]>((acc, h) => {
        const prev = acc[acc.length - 1];
        if (!prev || h.start >= prev.end) acc.push(h);
        return acc;
      }, []);

    if (acceptedHints.length === 0) {
      tokens.push(...shiftTokens(segmentRun(run.text, lexicon), runStart));
      continue;
    }

    // Re-segment each gap between accepted hints normally, and splice the
    // hints in as their own 'word' tokens.
    let cursor = runStart;
    for (const hint of acceptedHints) {
      if (hint.start > cursor) {
        const gapText = text.slice(cursor, hint.start);
        tokens.push(...shiftTokens(segmentRun(gapText, lexicon), cursor));
      }
      tokens.push({ text: text.slice(hint.start, hint.end), start: hint.start, end: hint.end, kind: 'word' });
      cursor = hint.end;
    }
    if (cursor < runEnd) {
      const gapText = text.slice(cursor, runEnd);
      tokens.push(...shiftTokens(segmentRun(gapText, lexicon), cursor));
    }
  }

  return tokens;
}
