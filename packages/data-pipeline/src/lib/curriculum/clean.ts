/**
 * Cleanup helpers for text extracted from 來學華語 (PyMuPDF). Pure functions,
 * fixture-tested. The PDF's ruby glyphs duplicate characters (名字 → 名字子),
 * variants are written `臺灣/ 台灣`, and tone variants `一/ 一/ 一`.
 */

export const POS_TAGS = new Set([
  'N',
  'V',
  'Vs',
  'Vi',
  'Vp',
  'Vst',
  'Vaux',
  'Adv',
  'Prep',
  'Conj',
  'QPr',
  'Pr',
  'M',
  'Det',
  'Part',
  'Num',
  'Nu',
  'Adj',
  'Prt',
  'Int',
  'Ptc',
  'Pron',
  'Aux',
  'Mw',
  'Dem',
  'Vp',
  'Nd',
  'Ndet',
]);

const CJK = /[㐀-鿿]/;
const PUNCT_TRAIL = /[？?。！!，、\s]+$/u;

/** Strip trailing punctuation/space from a headword. */
export function trimHeadword(s: string): string {
  return s.replace(PUNCT_TRAIL, '').trim();
}

/**
 * Split a vocab headword cell into [primary, ...variants].
 * `臺灣/ 台灣` → ['臺灣','台灣']; `一/ 一/ 一` → ['一'] (tone variants collapse);
 * `哪裡（哪兒）` → ['哪裡','哪兒'].
 */
export function splitVariants(raw: string): string[] {
  const parts: string[] = [];
  // Inline alternative for one character: 兄弟姊（姐）妹 → 兄弟姊妹 / 兄弟姐妹.
  const inline = raw.match(/^(.*?)(.)[（(]([^）)])[）)](.+)$/u);
  if (inline) {
    const [, a, b, c, d] = inline;
    return [`${a}${b}${d}`, `${a}${c}${d}`].map(trimHeadword);
  }
  const paren = raw.match(/^(.*?)[（(]([^）)]+)[）)]\s*$/u);
  const base = paren ? paren[1]! : raw;
  for (const p of base.split('/')) {
    const t = trimHeadword(p);
    if (t) parts.push(t);
  }
  if (paren) parts.push(trimHeadword(paren[2]!));
  return [...new Set(parts)];
}

/**
 * Fix ruby duplication: the PDF leaves a stray carrier glyph after some words
 * (名字 → 名字子, 喂 → 喂為). When the headword has more CJK chars than the
 * pinyin has syllables, drop the excess trailing chars.
 */
export function dedupeRuby(headword: string, syllables: number): string {
  const chars = [...headword];
  const cjk = chars.filter((c) => CJK.test(c)).length;
  if (syllables <= 0 || cjk <= syllables) return headword;
  let excess = cjk - syllables;
  while (excess > 0 && chars.length && CJK.test(chars.at(-1)!)) {
    chars.pop();
    excess--;
  }
  return chars.join('');
}

/** Count pinyin syllables in a tone-marked/space-separated string, e.g. "míngzi" → 2. */
export function countPinyinSyllables(py: string): number {
  const s = py
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\(.*?\)/g, '');
  let n = 0;
  for (const word of s.split(/[\s/]+/).filter(Boolean)) {
    const m = word.match(
      /(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(?:[aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+(?:ng|n|r)?)/giu,
    );
    n += m ? m.length : 0;
  }
  return n;
}

/** Normalise Taiwan/mainland variants to the primary book form (臺 kept; 台 is a variant). */
export function primaryOf(variants: string[]): { headword: string; variants: string[] } {
  const [headword = '', ...rest] = variants;
  return { headword, variants: rest };
}
