import { normalizePinyinText } from '@anan/core';

export interface ReviewNote {
  kind:
    | 'variant-merged'
    | 'split-alternates'
    | 'optional-char'
    | 'bopomofo-annotation-stripped'
    | 'stray-char-stripped'
    | 'unparseable-alternates'
    | 'paren-unrecognized'
    | 'multi-pos-split';
  headwordRaw: string;
  pinyinRaw: string;
  detail: string;
}

export interface RawSense {
  headword: string;
  variants: string[];
  pinyin: string;
  pos: string[];
}

const BOPOMOFO_RANGE = 'ㄅ-ㄩㆠ-ㆿ'; // bopomofo + bopomofo extended
// Halfwidth (...) in most rows, but one row uses fullwidth （...） instead.
const BOPOMOFO_ANNOTATION_RE = new RegExp(`[(（]˙?[${BOPOMOFO_RANGE}ˊˇˋ]+[)）]`, 'g');
const STRAY_CHAR_RE = /[\uF8F0-\uF8FF\u200B]/g; // PUA glyphs + zero-width space from the source doc

/** Strip zero-width spaces and private-use-area glyph artifacts left over
 * from whatever produced this spreadsheet (observed e.g. in "部分(˙ㄈㄣ)"). */
export function cleanRawCell(cell: string, notes: ReviewNote[], context: { headwordRaw: string; pinyinRaw: string }): string {
  const cleaned = cell.replace(STRAY_CHAR_RE, (m) => {
    notes.push({
      kind: 'stray-char-stripped',
      headwordRaw: context.headwordRaw,
      pinyinRaw: context.pinyinRaw,
      detail: `stripped stray character U+${m.codePointAt(0)!.toString(16).toUpperCase()}`,
    });
    return '';
  });
  return cleaned.trim();
}

/** Strip a bopomofo pronunciation annotation like 名字(˙ㄗ) -> 名字. This is
 * metadata about the final character's neutral tone, not an optional
 * character or an alternate spelling — MOE reading verification determines
 * the real reading independently. */
export function stripBopomofoAnnotation(headword: string, notes: ReviewNote[], pinyinRaw: string): string {
  if (!BOPOMOFO_ANNOTATION_RE.test(headword)) return headword;
  BOPOMOFO_ANNOTATION_RE.lastIndex = 0;
  const stripped = headword.replace(BOPOMOFO_ANNOTATION_RE, '');
  notes.push({
    kind: 'bopomofo-annotation-stripped',
    headwordRaw: headword,
    pinyinRaw,
    detail: `"${headword}" -> "${stripped}" (pronunciation hint, not part of the word)`,
  });
  return stripped;
}

interface OptionalCharResult {
  full: string;
  fullPinyin: string;
  short: string;
  shortPinyin: string;
}

/** Detect the "(一)點" / "小孩(子)" pattern: a parenthesized CJK segment in
 * the headword that is mirrored by a parenthesized romanization segment in
 * the pinyin cell, marking an optional/omittable part of the word. Returns
 * undefined if the headword has no CJK-content parens, or if the pattern
 * doesn't hold (mismatched/absent pinyin parens) — callers should flag that
 * case for human review rather than guess. */
export function splitOptionalChar(
  headword: string,
  pinyin: string,
): OptionalCharResult | undefined {
  // A slash means this cell has multiple whole alternatives, not one phrase
  // with an optional part — let the caller's slash-handling deal with it
  // (and re-run per-alternative cleanup), rather than this regex silently
  // eating the slash into `before`/`after`.
  if (headword.includes('/') || pinyin.includes('/')) return undefined;
  const hMatch = headword.match(/^(.*)\(([㐀-鿿豈-﫿]+)\)(.*)$/);
  if (!hMatch) return undefined;
  const [, before, optional, after] = hMatch;
  const full = `${before}${optional}${after}`;
  const short = `${before}${after}`;

  // Tolerate a stray space before the closing paren (observed: "jú(zi )").
  const pMatch = pinyin.match(/^(.*?)\s*\(([a-zA-Z1-5À-ɏ]+)\s*\)\s*(.*)$/);
  if (!pMatch) return undefined;
  const [, pBefore, pOptional, pAfter] = pMatch;
  const fullPinyin = `${pBefore}${pOptional}${pAfter}`;
  const shortPinyin = `${pBefore}${pAfter}`;

  return { full, fullPinyin, short: short || full, shortPinyin: shortPinyin || fullPinyin };
}

/**
 * Some rows redundantly combine the "/" and "()" optional-char conventions
 * for the same thing, e.g. "盤/盤(子)" or "刷(子) / 刷" — one alternative is
 * exactly the other with its parenthesized part stripped. Collapse these to
 * the single "()" form ("盤(子)") so splitOptionalChar can handle them
 * normally, instead of letting a stray "/" corrupt paren-extraction (which
 * doesn't know a slash might separate two whole alternatives).
 */
export function collapseRedundantSlashParen(headword: string): string {
  const parts = headword.split('/').map((s) => s.trim());
  if (parts.length !== 2) return headword;
  const [a, b] = parts as [string, string];
  const stripParens = (s: string) => s.replace(/[(（][^)）]*[)）]/g, '');
  if (/[(（]/.test(b) && stripParens(b) === a) return b;
  if (/[(（]/.test(a) && stripParens(a) === b) return a;
  return headword;
}

/** Split a "/"-joined POS cell into distinct tags, e.g. "N / Vst" -> ["N","Vst"]. */
export function splitPos(pos: string): string[] {
  return pos
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Split alternate headword/pinyin spellings joined by "/":
 *  - single pinyin, N headwords -> N spelling variants of ONE word (你/妳).
 *  - N headwords, N pinyins -> N distinct (headword, pinyin) words that
 *    happen to share a row (爸爸/爸 "bàba/bà").
 *  - anything else (count mismatch) -> unparseable; caller should fall back
 *    to the first alternative and flag the row for human review.
 */
export function splitAlternates(
  headwordRaw: string,
  pinyinRaw: string,
  notes: ReviewNote[],
): { headword: string; variants: string[]; pinyin: string }[] {
  const headwords = headwordRaw.split('/').map((s) => s.trim()).filter(Boolean);
  const pinyins = pinyinRaw.split('/').map((s) => normalizePinyinText(s)).filter(Boolean);

  if (headwords.length <= 1) return [{ headword: headwordRaw, variants: [], pinyin: pinyinRaw }];

  if (pinyins.length === 1) {
    notes.push({
      kind: 'variant-merged',
      headwordRaw,
      pinyinRaw,
      detail: `${headwords.join(', ')} merged as spelling variants of one word (shared reading "${pinyins[0]}")`,
    });
    return [{ headword: headwords[0]!, variants: headwords.slice(1), pinyin: pinyins[0]! }];
  }

  if (pinyins.length === headwords.length) {
    notes.push({
      kind: 'split-alternates',
      headwordRaw,
      pinyinRaw,
      detail: `split into ${headwords.length} distinct words: ${headwords.map((h, i) => `${h}/${pinyins[i]}`).join(', ')}`,
    });
    return headwords.map((h, i) => ({ headword: h, variants: [], pinyin: pinyins[i]! }));
  }

  notes.push({
    kind: 'unparseable-alternates',
    headwordRaw,
    pinyinRaw,
    detail: `${headwords.length} headword alternatives but ${pinyins.length} pinyin alternatives — counts don't match; kept "${headwords[0]}"/"${pinyins[0]}" only, rest need manual review`,
  });
  return [{ headword: headwords[0]!, variants: [], pinyin: pinyins[0] ?? pinyinRaw }];
}

/**
 * Full normalization pipeline for one TOCFL row -> one or more RawSense
 * records (one per resulting headword/reading/POS combination).
 */
export function normalizeRow(
  headwordCellRaw: string,
  pinyinCellRaw: string,
  posCellRaw: string,
  notes: ReviewNote[],
): RawSense[] {
  const ctx = { headwordRaw: headwordCellRaw, pinyinRaw: pinyinCellRaw };
  let headwordCell = cleanRawCell(headwordCellRaw, notes, ctx);
  const pinyinCell = normalizePinyinText(cleanRawCell(pinyinCellRaw, notes, ctx));
  headwordCell = stripBopomofoAnnotation(headwordCell, notes, pinyinCellRaw);
  // Only collapse "A/A(B)" when the pinyin cell has no slash of its own
  // (single shared reading like "pán(zi)") — when pinyin ALSO has a slash
  // (e.g. 盒/盒(子) with pinyin "hé/hézi"), the two alternatives are
  // genuinely distinct senses (often different POS) and splitAlternates
  // below should zip them normally instead.
  if (!pinyinCell.includes('/')) headwordCell = collapseRedundantSlashParen(headwordCell);

  const posList = splitPos(posCellRaw);
  if (posList.length > 1) {
    notes.push({
      kind: 'multi-pos-split',
      headwordRaw: headwordCellRaw,
      pinyinRaw: pinyinCellRaw,
      detail: `"${headwordCellRaw}" has ${posList.length} POS tags (${posList.join(', ')}) -> one sense per POS`,
    });
  }

  const optional = splitOptionalChar(headwordCell, pinyinCell);
  let base: { headword: string; variants: string[]; pinyin: string }[];
  if (optional) {
    notes.push({
      kind: 'optional-char',
      headwordRaw: headwordCellRaw,
      pinyinRaw: pinyinCellRaw,
      detail: `"${optional.full}" (${optional.fullPinyin}) / "${optional.short}" (${optional.shortPinyin}) — optional component, kept as two variants of one word`,
    });
    base = [{ headword: optional.full, variants: [optional.short], pinyin: optional.fullPinyin }];
  } else if (headwordCell.includes('/')) {
    // A slash alongside an unmirrored paren (e.g. "盒/盒(子)" with pinyin
    // "hé/hézi", no parens there at all) — split on "/" first (each side is
    // usually a genuinely distinct sense, often a different POS); any stray
    // paren left on an individual alternative is cleaned up below.
    base = splitAlternates(headwordCell, pinyinCell, notes);
  } else if (/[㐀-鿿豈-﫿]\(/.test(headwordCell)) {
    // Looked like it might be the optional-char pattern (has a CJK-preceded
    // paren) but didn't mirror in the pinyin cell — flag rather than guess.
    notes.push({
      kind: 'paren-unrecognized',
      headwordRaw: headwordCellRaw,
      pinyinRaw: pinyinCellRaw,
      detail: `parenthesized segment in "${headwordCell}" not mirrored in pinyin "${pinyinCell}" — kept as-is, needs manual review`,
    });
    base = [{ headword: headwordCell, variants: [], pinyin: pinyinCell }];
  } else {
    base = splitAlternates(headwordCell, pinyinCell, notes);
  }

  // Cleanup: an individual alternative may still carry a stray paren with no
  // pinyin-side counterpart of its own (e.g. the "盒(子)"/"hézi" sense out of
  // "盒/盒(子)" above) — that's just the full form spelled redundantly;
  // expand it rather than leaving literal parentheses in the headword.
  base = base.map((b) => {
    const hasParens = (s: string) => s.includes('(') || s.includes('（');
    if (!hasParens(b.headword) && !hasParens(b.pinyin)) return b;
    const expand = (s: string) => s.replace(/[(（]([^)）]+)[)）]/g, '$1');
    const expandedHeadword = expand(b.headword);
    const expandedPinyin = expand(b.pinyin);
    notes.push({
      kind: 'paren-unrecognized',
      headwordRaw: headwordCellRaw,
      pinyinRaw: pinyinCellRaw,
      detail: `"${b.headword}" (${b.pinyin}) -> "${expandedHeadword}" (${expandedPinyin}) (expanded stray optional-char parens with no matched counterpart for this alternative)`,
    });
    return { ...b, headword: expandedHeadword, pinyin: expandedPinyin };
  });

  const senses: RawSense[] = [];
  if (base.length > 1 && base.length === posList.length) {
    // Both a headword/reading split AND a multi-POS split happened, with
    // matching counts (e.g. "盒/盒子" M/N) — zip 1:1 rather than cross
    // producing every combination, which would invent senses the row never
    // claimed (盒子 as M, 盒 as N).
    notes.push({
      kind: 'multi-pos-split',
      headwordRaw: headwordCellRaw,
      pinyinRaw: pinyinCellRaw,
      detail: `zipped ${base.length} alternatives 1:1 with ${base.length} POS tags rather than cross-producing: ${base.map((b, i) => `${b.headword}/${posList[i]}`).join(', ')}`,
    });
    for (let i = 0; i < base.length; i++) {
      const b = base[i]!;
      senses.push({ headword: b.headword, variants: b.variants, pinyin: b.pinyin, pos: [posList[i]!] });
    }
    return senses;
  }
  for (const b of base) {
    for (const pos of posList.length > 0 ? posList : ['']) {
      senses.push({ headword: b.headword, variants: b.variants, pinyin: b.pinyin, pos: pos ? [pos] : [] });
    }
  }
  return senses;
}
