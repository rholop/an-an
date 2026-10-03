/** Pinyin as a comparison key: lower-case, no spaces/apostrophes/dots. */
export function pinyinKey(p: string): string {
  return p
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s'’·.-]/g, '');
}

/** Split on `sep` but not inside (), [], 「」 — CEDICT glosses embed those. */
export function splitOutsideParens(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '（') depth++;
    else if (ch === ')' || ch === ']' || ch === '）') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A gloss with its register/region markers pulled out as tags. */
export interface ParsedGloss {
  text: string;
  tags: string[];
  /** Looks like a non-meaning: surname, variant-of, see-also, abbreviation … */
  junk: boolean;
}

const TAG_MARKERS: [RegExp, string][] = [
  [/\(Tw\)|\(Taiwan\)|\bTaiwan pr\./i, 'taiwan'],
  [/\((?:PRC|Mainland)[^)]*\)/i, 'mainland'],
  [/\(slang\)|\(coll\.\)|\(colloquial\)|\(dialect\)|\(vulgar\)/i, 'informal'],
  [/\(literary\)|\(archaic\)|\(old\)|\(classical\)/i, 'literary'],
  [/\(loanword\)/i, 'loanword'],
  [
    /\(Buddhism\)|\(medicine\)|\(math\.\)|\(chemistry\)|\(physics\)|\(geology\)|\(botany\)|\(zoology\)|\(music\)|\(law\)|\(computing\)|\(linguistics\)|\(astronomy\)/i,
    'technical',
  ],
];

const JUNK =
  /^(?:(?:a )?surname\b|alternative form of\b|erhua form of\b|misspelling of\b|variant of\b|old variant of\b|also written\b|see\b|abbr\. for\b|abbreviation\b|erhua variant\b|Japanese variant\b|archaic variant\b|used in\b|used in names\b|CL:|\(Tw\) variant)/i;

export function parseGloss(raw: string): ParsedGloss {
  const tags: string[] = [];
  let text = raw.trim();
  // Slang is also 'informal', but is only taught when it's Taiwan usage
  // (機車 "annoying" yes; 機場 "flat chest" no) — see rankCandidates.
  const slang = /\(slang\)|\(vulgar\)/i.test(text);
  for (const [re, tag] of TAG_MARKERS) {
    if (re.test(text)) {
      tags.push(tag);
      text = text.replace(re, '').trim();
    }
  }
  text = text
    // "CL:個|个[ge4],隻|只[zhi1]" lists classifiers with commas, sometimes in
    // parentheses ("mouth (CL:張|张[zhang1])"): drop the whole list.
    .replace(/\(\s*CL:[^)]*\)/g, '')
    .replace(/\bCL:[^;]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[;,\s]+|[;,\s]+$/g, '')
    .trim();
  if (slang) tags.push('slang');
  // "[jie3]", "[jie3 jie5]" alone: the pointer left over from "variant of 姐姐[jie3 jie5]".
  const pointer = /^\[[a-z]+\d(?: [a-z]+\d)*\]$/i.test(text);
  return { text, tags, junk: JUNK.test(text) || pointer || text === '' };
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'or',
  'and',
  'in',
  'on',
  'for',
  'be',
  'is',
  'sth',
  'sb',
  'one',
  'ones',
  "one's",
]);

/** Lower-case content tokens with a crude plural/-ing/-ed stem, for overlap. */
export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(?:ing|ed|es|s)$/, (m) => (t.length - m.length >= 3 ? '' : m)));
}

/** Shared-token overlap in [0,1] (relative to the smaller set). */
export function glossOverlap(a: string, b: string): number {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (A.size === 0 || B.size === 0)
    // All stop words ("to be", "to do"): only an identical gloss overlaps.
    return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== '' ? 1 : 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** ≤ maxWords words: drop parentheticals and "e.g." tails, then keep whole
 * `;`-clauses while they fit ("scooter; motorcycle", "hard to get along
 * with; annoying"); a first clause that is itself too long is truncated.
 * Never adds words, so the result is always a subset of the source text
 * (and therefore supported by it). */
export function condenseGloss(text: string, maxWords = 6): string {
  const cleaned = text
    .replace(/\([^)]*\)/g, '')
    .replace(/\be\.g\..*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A gloss that is ONLY a parenthetical ("(completed action marker)",
  // "(adverb of degree)") is the meaning for particles and function words.
  const source =
    cleaned === ''
      ? text
          .replace(/[()]/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
      : cleaned;
  const clauses = splitOutsideParens(source, ';').map((c) =>
    c.replace(/,.*$/, (rest) => (c.split(/\s+/).length > maxWords ? '' : rest)).trim(),
  );
  const out: string[] = [];
  let words = 0;
  for (const clause of clauses) {
    const n = clause.split(/\s+/).filter(Boolean).length;
    if (n === 0) continue;
    if (out.length === 0 && n > maxWords)
      return clause
        .split(/\s+/)
        .slice(0, maxWords)
        .join(' ')
        .replace(/[,;:]+$/, '');
    if (words + n > maxWords) break;
    out.push(clause);
    words += n;
  }
  return out.join('; ').replace(/[,;:]+$/, '');
}
