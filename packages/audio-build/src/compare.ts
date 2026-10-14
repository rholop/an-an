const DIGITS = '〇一二三四五六七八九';

/** Keep only Han characters and letters/digits, so punctuation, spacing and
 * STT formatting ("你好。") never cause a mismatch. A single Arabic digit is
 * read as its Chinese numeral. */
export function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[0-9]/g, (d) => DIGITS[Number(d)]!)
    .replace(/[^\p{Script=Han}a-z〇]/gu, '');
}

/** The automatic check: what was recognised must equal what was meant. It
 * catches gross errors (wrong word, garbled clip), not tone subtleties. */
export function recognisedMatches(expected: string, heard: string): boolean {
  const a = normalizeForCompare(expected);
  return a.length > 0 && a === normalizeForCompare(heard);
}
