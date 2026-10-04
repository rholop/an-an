/**
 * The appendix 生詞索引 (vocabulary index): per entry pinyin, traditional,
 * simplified, English and a `lesson-n` locator that points at the entry's
 * number in the lesson vocabulary. Used as an independent cross-check of the
 * lesson parse (same headword at the same locator) and to repair headwords the
 * PDF text layer garbled.
 */
export interface IndexEntry {
  pinyin: string;
  headword: string;
  lesson: number;
  n: number;
}

const CJK = /[㐀-鿿]/;
const LOCATOR = /(?:^|\s)(\d{1,2})-(\d{1,2})$/;
const HEADER = new Set([
  'Vocabulary Index',
  '生詞',
  '索引',
  'Pinyin',
  'Traditional',
  'Characters',
  'Simplified',
  'English',
  'Lesson',
  'Number',
]);

export function parseVocabIndex(pageTexts: string[]): IndexEntry[] {
  const out: IndexEntry[] = [];
  let buf: string[] = [];
  for (const text of pageTexts) {
    for (const raw of text.split('\n')) {
      const l = raw.replace(/ /g, ' ').trim();
      if (!l || HEADER.has(l) || /^\d{3}$/.test(l) || /^[A-Z]$/.test(l)) continue;
      const m = LOCATOR.exec(l);
      if (!m) {
        buf.push(l);
        continue;
      }
      const before = l.slice(0, m.index).trim();
      if (before) buf.push(before);
      const pinyin = buf[0] ?? '';
      const trad = buf.slice(1).find((x) => CJK.test(x) && !/[A-Za-z]{3}/.test(x)) ?? '';
      out.push({ pinyin, headword: trad.replace(/\s+/g, ''), lesson: Number(m[1]), n: Number(m[2]) });
      buf = [];
    }
  }
  return out;
}
