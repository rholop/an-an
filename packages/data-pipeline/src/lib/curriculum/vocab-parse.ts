import { countPinyinSyllables, dedupeRuby, POS_TAGS, splitVariants } from './clean.js';

export type VocabSection = 'core' | 'phrase' | 'proper' | 'supplementary';

export interface BookWord {
  lesson: number;
  n: number; // the book's item number
  section: VocabSection;
  headword: string;
  variants: string[];
  pinyin: string;
  pos: string[];
  glossEn: string;
}

const SECTION_HEADINGS: Array<[RegExp, VocabSection]> = [
  [/^生詞\s*Vocabulary$/i, 'core'],
  [/^短語\s*Phrases$/i, 'phrase'],
  [/^專有名詞\s*Proper\s*Nouns?$/i, 'proper'],
  [/^補充生詞\s*Supplementary\s*Vocabulary$/i, 'supplementary'],
];

const CJK = /[㐀-鿿]/;

/** Flatten page text to trimmed non-empty lines. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
}

interface RawEntry {
  n: number;
  lines: string[];
}

export interface PageFurniture {
  titleZh: string;
  titleEn: string;
}

const ENTRY_START = /^(\d{1,2})\.\s*(.*)$/u;
const LOOKS_HEADWORD = /^(?:O\s)?[\u3400-\u9fff]/u;

/**
 * Drop the running header at the top of a page: `Lesson / 026 / <zh title> / 03`
 * on even pages, `027 / <English title>` on odd ones. Titles may wrap over
 * two lines, so match them against the known full titles by prefix.
 */
function stripFurniture(ls: string[], f: PageFurniture): string[] {
  let i = 0;
  if (ls[i] === 'Lesson') i++;
  if (/^\d{3}$/.test(ls[i] ?? '')) i++;
  else if (i === 0) return ls;
  const take = (title: string, stop: RegExp) => {
    let acc = '';
    let j = i;
    while (
      j < ls.length &&
      title.replace(/\s+/g, '').startsWith((acc + ls[j]).replace(/\s+/g, '')) &&
      !stop.test(ls[j]!)
    ) {
      acc += ls[j];
      j++;
    }
    return j;
  };
  const afterZh = take(f.titleZh, /^\d/);
  if (afterZh > i) i = afterZh;
  else {
    const afterEn = take(f.titleEn, /^\d/);
    if (afterEn > i) i = afterEn;
  }
  if (/^(?:0\d|10)$/.test(ls[i] ?? '')) i++;
  return ls.slice(i);
}

/**
 * A lesson's vocabulary pages → raw numbered entries with sections.
 *
 * The book numbers items continuously in the order core → phrases → proper
 * nouns → supplementary, but PyMuPDF emits the side-column headings in a
 * jumbled order. Each heading closes the LAST contiguous run of numbers
 * before it; runs without a heading inherit the section of the nearest lower
 * labelled number (they continue a block whose heading printed earlier).
 */
export function parseVocabBlock(
  pageTexts: string[],
  furniture: PageFurniture,
): Array<RawEntry & { section: VocabSection }> {
  const runs: RawEntry[][] = [];
  const runSection = new Map<RawEntry[], VocabSection>();
  let run: RawEntry[] = [];
  let cur: RawEntry | null = null;
  const closeEntry = () => {
    if (cur) run.push(cur);
    cur = null;
  };
  const closeRun = () => {
    closeEntry();
    if (run.length) runs.push(run);
    run = [];
  };
  for (const text of pageTexts) {
    const ls = stripFurniture(lines(text), furniture);
    for (let i = 0; i < ls.length; i++) {
      const raw = ls[i]!;
      if (/^語法\s*Grammar$/.test(raw)) {
        closeEntry();
        continue;
      }
      const sec = SECTION_HEADINGS.find(([re]) => re.test(raw));
      if (sec) {
        closeRun();
        const last = runs.at(-1);
        if (last && !runSection.has(last)) runSection.set(last, sec[1]);
        continue;
      }
      const m = raw.match(ENTRY_START);
      if (m) {
        const rest = m[2]!;
        const headLine = rest || ls[i + 1] || '';
        if (LOOKS_HEADWORD.test(headLine)) {
          const n = Number(m[1]);
          const prev: number | undefined = cur ? (cur as RawEntry).n : run.at(-1)?.n;
          closeEntry();
          if (prev !== undefined && n !== prev + 1) {
            closeRun();
          }
          cur = { n, lines: rest ? [rest] : [] };
          continue;
        }
      }
      if (cur) (cur as RawEntry).lines.push(raw);
    }
  }
  closeRun();
  // Unlabelled runs inherit from the nearest lower labelled run.
  const flat: Array<RawEntry & { section: VocabSection }> = [];
  const labelled = runs
    .filter((r) => runSection.has(r))
    .map((r) => ({ min: r[0]!.n, section: runSection.get(r)! }))
    .sort((a, b) => a.min - b.min);
  for (const r of runs) {
    const own = runSection.get(r);
    const section: VocabSection =
      own ?? [...labelled].reverse().find((l) => l.min < r[0]!.n)?.section ?? 'core';
    for (const e of r) flat.push({ ...e, section });
  }
  // Proper nouns and phrases carry no part of speech; supplementary entries do.
  // A POS-bearing entry at the end of a 'proper' run is really 補充生詞.
  for (const e of flat) {
    if (e.section === 'proper' && hasPos(e.lines)) e.section = 'supplementary';
  }
  return flat.sort((a, b) => a.n - b.n);
}

function hasPos(entryLines: string[]): boolean {
  const cells = entryLines.slice();
  if (cells.length && CJK.test(cells[0]!)) {
    const m = cells[0]!.match(/^(.*[\u3400-\u9fff？?）)])\s+([A-Za-z].*)$/u);
    if (m) cells.splice(0, 1, m[1]!, m[2]!);
  }
  return !!cells[2] && isPosCell(cells[2]);
}

/** Turn a raw entry into a BookWord (headword/pinyin/POS/gloss). */
export function entryToWord(lesson: number, e: RawEntry & { section: VocabSection }): BookWord {
  // Join then re-split on the cell boundaries PyMuPDF gives as separate lines.
  let cells = e.lines.slice();
  // First cell may hold "headword pinyin" glued (哪裡（哪兒） nǎlǐ (nǎr)).
  if (cells.length && CJK.test(cells[0]!)) {
    const m = cells[0]!.match(/^(.*[㐀-鿿？?）)])\s+([A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü].*)$/u);
    if (m) cells = [m[1]!, m[2]!, ...cells.slice(1)];
  }
  const headRaw = cells[0] ?? '';
  const pinyin = (cells[1] ?? '').trim();
  let idx = 2;
  const pos: string[] = [];
  if (cells[idx] && isPosCell(cells[idx]!)) {
    pos.push(
      ...cells[idx]!.split('/')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    idx++;
  }
  const glossEn = cells.slice(idx).join(' ').replace(/\s+/g, ' ').trim();
  const variantsAll = splitVariants(headRaw).map((v) =>
    CJK.test(v) ? v.replace(/^[A-Za-z]+\s+/, '') : v,
  );
  const syll = countPinyinSyllables(pinyin.split('/')[0] ?? pinyin);
  const fixed = variantsAll.map((v, i) => (i === 0 ? dedupeRuby(v, syll) : v));
  const [headword = '', ...variants] = fixed;
  return {
    lesson,
    n: e.n,
    section: e.section,
    headword,
    variants,
    pinyin,
    pos,
    glossEn,
  };
}

function isPosCell(s: string): boolean {
  return s
    .split('/')
    .map((x) => x.trim())
    .every((x) => POS_TAGS.has(x));
}
