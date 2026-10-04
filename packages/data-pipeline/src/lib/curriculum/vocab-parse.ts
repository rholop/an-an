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
const TONES = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;

/** Flatten page text to trimmed non-empty lines. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    // The PDF prints a stray "Phrase" tag next to some phrase entries (book 2).
    .filter((l) => l && l !== 'Phrase');
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
const LOOKS_HEADWORD = /^(?:O\s)?(?:[…（(\ufffd\u3400-\u9fff]|[A-Z]{2,}\b)/u;

/**
 * Drop the running header at the top of a page. Depending on the book it is
 * `Lesson / 026 / <zh title> / 03` (book 1), `002 / Lesson / <zh title> / 01`
 * (book 2), `Lesson01 <zh title>` (books 3–4) on even pages, and `027 /
 * <English title>` on odd ones. Titles may wrap over two lines, so a line is
 * dropped when it is a fragment of the lesson's known zh or English title.
 */
function stripFurniture(ls: string[], f: PageFurniture): string[] {
  const squash = (x: string) => x.replace(/\s+/g, '');
  const zh = squash(f.titleZh);
  const en = squash(f.titleEn).toLowerCase();
  let i = 0;
  let sawPageNo = false;
  while (i < ls.length && i < 8) {
    const l = ls[i]!;
    const q = squash(l);
    if (l === 'Lesson' || /^Lesson\s?\d{2}\b/.test(l)) {
      i++;
    } else if (/^\d{3}$/.test(l) && !sawPageNo) {
      sawPageNo = true;
      i++;
    } else if (/^(?:0\d|10)$/.test(l) && i > 0) {
      i++;
    } else if (q && ((zh && zh.includes(q) && /[㐀-鿿]/.test(q)) || (en.length > 2 && q.length > 2 && en.includes(q.toLowerCase())))) {
      i++;
    } else break;
  }
  return i > 0 ? ls.slice(i) : ls;
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
export interface VocabParseOptions {
  /**
   * 'headings' (book 1): sections come from the side-column headings.
   * 'order' (books 2–4): the headings are not trusted (a page break can leave
   * 生詞 and 短語 entries in one run, and 專有名詞 trailing a run with 短語);
   * entries are numbered core → phrases → proper nouns → supplementary, so the
   * section follows from the entry itself (see `classifyByOrder`).
   */
  sections?: 'headings' | 'order';
  /** Heading regex sources per section (defaults: the book 1 strings). */
  headings?: Record<VocabSection, string>;
  /** Regex source of the heading that ends the vocabulary (default `語法\s*Grammar`). */
  grammarHeading?: string;
}

export function parseVocabBlock(
  pageTexts: string[],
  furniture: PageFurniture,
  opts: VocabParseOptions = {},
): Array<RawEntry & { section: VocabSection }> {
  const headings: Array<[RegExp, VocabSection]> = opts.headings
    ? (Object.entries(opts.headings) as Array<[VocabSection, string]>).map(([k, v]) => [
        new RegExp(v, 'i'),
        k,
      ])
    : SECTION_HEADINGS;
  const grammarRe = new RegExp(opts.grammarHeading ?? '^語法\\s*Grammar$');
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
      if (grammarRe.test(raw)) {
        closeEntry();
        continue;
      }
      const sec = headings.find(([re]) => re.test(raw));
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
  if (opts.sections === 'order') return classifyByOrder(runs.flat());
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

const CAPITAL_PINYIN = /^[A-ZĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙ]/u;

/**
 * Sections from the entries alone: POS-bearing entries up to the first entry
 * without a POS are core 生詞; then 短語 (no POS, lower-case pinyin) and
 * 專有名詞 (no POS, capitalised pinyin); POS-bearing entries after that are
 * 補充生詞. Entries are expected in book order.
 */
export function classifyByOrder(
  entries: RawEntry[],
): Array<RawEntry & { section: VocabSection }> {
  const sorted = [...entries].sort((a, b) => a.n - b.n);
  const seen = new Set<number>();
  const out: Array<RawEntry & { section: VocabSection }> = [];
  let afterPhrases = false;
  for (const e of sorted) {
    if (seen.has(e.n)) continue; // a number repeated by a later page (running text)
    seen.add(e.n);
    const w = entryToWord(0, { ...e, section: 'core' });
    const pos = w.pos.length > 0;
    let section: VocabSection;
    if (pos) section = afterPhrases ? 'supplementary' : 'core';
    else {
      afterPhrases = true;
      section = CAPITAL_PINYIN.test(w.pinyin) ? 'proper' : 'phrase';
    }
    out.push({ ...e, section });
  }
  return out;
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
export function entryToWord(
  lesson: number,
  e: RawEntry & { section: VocabSection },
  opts: { dedupeRuby?: boolean } = {},
): BookWord {
  // Join then re-split on the cell boundaries PyMuPDF gives as separate lines.
  let cells = e.lines.slice();
  // First cell may hold "headword pinyin" glued (哪裡（哪兒） nǎlǐ (nǎr)).
  if (cells.length && CJK.test(cells[0]!)) {
    const m = cells[0]!.match(/^(.*[㐀-鿿？?）)])\s*([A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü].*)$/u);
    if (m) cells = [m[1]!, m[2]!, ...cells.slice(1)];
  }
  // "chāojí shìchǎng N": the part of speech was glued to the end of the reading line.
  if (cells.length > 1 && cells[1] && !isPosCell(cells[2] ?? '')) {
    const g = cells[1].match(/^(.*\S)\s+([A-Z][A-Za-z]{0,4}(?:\/[A-Z][A-Za-z]{0,4})*)$/);
    if (g && isPosCell(g[2]!)) cells = [cells[0]!, g[1]!, g[2]!, ...cells.slice(2)];
  }
  // "jīròu sānmíngzhì (chicken sandwich)": the gloss was glued to the reading.
  if (cells.length === 2 || (cells.length > 1 && cells.slice(2).join('').trim() === '')) {
    const g = (cells[1] ?? '').match(/^(.*?)\s*\(([A-Za-z][^()]*)\)$/);
    if (g && !TONES.test(g[2]!) && /\s|[a-z]{5,}/.test(g[2]!)) cells = [cells[0]!, g[1]!, g[2]!];
  }
  // A long headword wrapped onto a second line (東方美人 / 茶), and a reading wrapped over several lines.
  if (cells[1] && CJK.test(cells[1]) && !/[A-Za-z]/.test(cells[1]) && [...cells[1]].length <= 2) {
    cells = [cells[0] + cells[1], ...cells.slice(2)];
  }
  if (cells.length > 3 && !isPosCell(cells[2] ?? '')) {
    for (let k = 3; k <= 4 && k < cells.length; k++) {
      if (isPosCell(cells[k]!) && cells.slice(1, k).every((c) => !CJK.test(c))) {
        cells = [cells[0]!, cells.slice(1, k).join(' '), ...cells.slice(k)];
        break;
      }
    }
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
  // The gloss is English: when an entry ends a page, the lines that follow (dialogue
  // text, its pinyin, "(1) …" examples) must not be folded into it.
  const glossCells: string[] = [];
  for (const c of cells.slice(idx)) {
    if (CJK.test(c.replace(/[“”’‘—–"'’]/g, '')) && glossCells.length > 0 && !/^[(（][^)）]*[)）]?$/.test(c)) break;
    if (glossCells.length > 0 && (TONES.test(c) || /^\(\d\)/.test(c))) break;
    glossCells.push(c);
  }
  const glossEn = glossCells.join(' ').replace(/\s+/g, ' ').trim();
  const variantsAll = splitVariants(headRaw).map((v) =>
    CJK.test(v) ? v.replace(/^[A-Za-z]+\s+/, '') : v,
  );
  const syll = countPinyinSyllables(pinyin.split('/')[0] ?? pinyin);
  const fixed = variantsAll.map((v, i) =>
    i === 0 && opts.dedupeRuby !== false ? dedupeRuby(v, syll) : v,
  );
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
