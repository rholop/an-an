/**
 * Phase 34 B: find vocabulary on a lesson's pages that sits outside the four parsed
 * sections (labelled picture boxes, word banks, tables). Pure text in, candidates out;
 * the script `curriculum-extras.ts` does the file work, linking and yaml.
 *
 * A candidate is a short Chinese term (1–6 characters) with pinyin, an English gloss or
 * both on the same line / in the same text block. Sentences are never candidates: a
 * term followed by punctuation, longer than six characters, starting with a capital
 * pinyin syllable (names, sentence starts) or glossed by a full sentence is dropped.
 */
import { countPinyinSyllables, dedupeRuby, POS_TAGS } from './clean.js';

export type ExtraFound = 'label' | 'table' | 'word-bank' | 'image';

export interface RawCandidate {
  headword: string;
  /** Other written forms (她/他). */
  variants: string[];
  pinyin: string;
  glossEn: string;
  found: ExtraFound;
  /** Capitalised reading: a name or place, never proposed (listed in the report). */
  proper?: boolean;
}

const HAN = '\\u3400-\\u9fff';
const TONES = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;
const ZH_RUN = new RegExp(`^[${HAN}]+(?:[/／][${HAN}]+)?`);
const ZH_ONLY = new RegExp(`^[${HAN}]+$`);
const PUNCT_AFTER = /^[，。？！：；、「」『』“”（）()…—\-～~]/;
const PINYIN_TOKEN = /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ’'-]+$/i;

/** Drop the printed item number ("3.", "10.") that starts a table row. */
function stripNumber(line: string): string {
  return line.replace(/^\s*\d{1,2}\s*[.．、]\s*/, '').replace(/^\s*[①-⑩]\s*/, '').trim();
}

/** Tone marks count too: wǔān is two syllables the vowel-run counter reads as one. */
function syllables(py: string): number {
  return Math.max(countPinyinSyllables(py), (py.normalize('NFC').match(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/g) ?? []).length);
}

const CAPITAL = /^[A-ZĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙ]/u;

function plausiblePinyin(py: string, headword: string): boolean {
  if (!py) return false;
  const toks = py.split(/\s+/);
  if (!toks.every((t) => PINYIN_TOKEN.test(t))) return false;
  const chars = headword.replace(/[/／].*$/, '').length;
  const syll = syllables(py);
  // short words must match exactly (a ruby carrier makes 午 → wǔān); longer ones may differ by a neutral/er syllable
  return syll >= 1 && (chars <= 2 ? syll === chars : Math.abs(syll - chars) <= 1);
}

function plausibleGloss(g: string): boolean {
  if (!g) return true;
  if (CJK_IN(g) || /[.?!。？！：:]$/.test(g)) return false;
  if (g.split(/\s+/).length > 8) return false;
  return /[A-Za-z]/.test(g);
}

function CJK_IN(s: string): boolean {
  return new RegExp(`[${HAN}]`).test(s);
}

/** Split "pinyin gloss" glued by single spaces: the pinyin is the leading tokens that read as syllables. */
function splitPinyinGloss(rest: string, chars: number): { pinyin: string; gloss: string } {
  const toks = rest.split(/\s+/).filter(Boolean);
  let i = 0;
  let syll = 0;
  let sawTone = false;
  while (i < toks.length && PINYIN_TOKEN.test(toks[i]!) && syll < chars) {
    const t = toks[i]!;
    if (TONES.test(t)) sawTone = true;
    syll += countPinyinSyllables(t);
    i++;
  }
  // A line with no tone mark at all is English (or toneless noise), not pinyin.
  if (!sawTone) return { pinyin: '', gloss: rest.trim() };
  return { pinyin: toks.slice(0, i).join(' '), gloss: toks.slice(i).join(' ') };
}

function parseRow(line: string): { headword: string; pinyin: string; glossEn: string; cells: number; proper: boolean } | null {
  const body = stripNumber(line.replace(/\t/g, '  '));
  const m = ZH_RUN.exec(body);
  if (!m) return null;
  const headword = m[0].replace(/\s+/g, '');
  const afterZh = body.slice(m[0].length);
  if (PUNCT_AFTER.test(afterZh.trimStart()) && !/^\s/.test(afterZh)) return null; // 你好嗎？
  if (/^[，。？！：；、「」『』“”]/.test(afterZh.trimStart())) return null;
  const chars = headword.replace(/[/／].*$/, '').length;
  if (chars < 1 || chars > 6) return null;
  const rest = afterZh.trim();
  if (!rest) return null;
  if (CJK_IN(rest)) return null; // more Chinese on the line: a sentence, a grid row, a dialogue
  const cells = rest.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
  let pinyin = '';
  let glossEn = '';
  if (cells.length >= 2 && (TONES.test(cells[0]!) || PINYIN_TOKEN.test(cells[0]!.replace(/\s+/g, '')))) {
    pinyin = cells[0]!;
    glossEn = cells.slice(1).join(' ');
  } else if (cells.length === 1) {
    ({ pinyin, gloss: glossEn } = (() => {
      const r = splitPinyinGloss(cells[0]!, chars);
      return { pinyin: r.pinyin, gloss: r.gloss };
    })());
  } else {
    return null;
  }
  glossEn = glossEn.replace(/\s+/g, ' ').trim();
  if (!pinyin && !glossEn) return null;
  if (pinyin && !plausiblePinyin(pinyin, headword)) return null;
  if (!plausibleGloss(glossEn)) return null;
  if (!pinyin && !glossEn) return null;
  return { headword, pinyin, glossEn, cells: cells.length, proper: CAPITAL.test(pinyin) };
}

/** Rows read from `pdftotext -layout` text (tables and labelled boxes), one per line. */
export function scanLayoutPage(layout: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const line of layout.split('\n')) {
    if (!line.trim()) continue;
    const r = parseRow(line);
    if (!r) continue;
    const numbered = /^\s*\d{1,2}\s*[.．、]/.test(line);
    out.push({
      headword: r.headword,
      variants: [],
      pinyin: r.pinyin,
      glossEn: r.glossEn,
      found: numbered || r.cells >= 2 ? 'table' : 'label',
      ...(r.proper ? { proper: true } : {}),
    });
  }
  return out;
}

/**
 * Blocks read from the extractor's text (one cell per line): a Chinese term, then its
 * pinyin and/or English on the next lines ("工程師 / gōngchéngshī / engineer").
 */
export function scanBlockPage(text: string): RawCandidate[] {
  const ls = text
    .split('\n')
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  const out: RawCandidate[] = [];
  for (let i = 0; i < ls.length; i++) {
    let head = ls[i]!;
    if (/^\d{1,2}\.?$/.test(head)) {
      i++;
      if (i >= ls.length) break;
      head = ls[i]!;
    } else head = head.replace(/^\d{1,2}\s*[.．、]\s*/, '');
    if (!ZH_ONLY.test(head.replace(/[/／]/g, '')) || head.replace(/[/／]/g, '').length > 6) continue;
    const py = ls[i + 1] ?? '';
    if (!py || CJK_IN(py) || !TONES.test(py) || !plausiblePinyin(py, head)) continue;
    const en = ls[i + 2] ?? '';
    const gloss = en && !CJK_IN(en) && !TONES.test(en) && !/^\d{1,2}\.?$/.test(en) && plausibleGloss(en) ? en : '';
    out.push({ headword: head, variants: [], pinyin: py, glossEn: gloss, found: 'word-bank', ...(CAPITAL.test(py) ? { proper: true } : {}) });
  }
  return out;
}

/** Printed page number from the page's own text ("053" footer or header), if there is one. */
export function printedPage(text: string): number | undefined {
  const ls = text.split('\n').map((l) => l.trim());
  const m = [...ls.slice(0, 4), ...ls.slice(-3)].find((l) => /^0\d{2}$/.test(l));
  return m ? Number(m) : undefined;
}

/** Section and page headings the books print in Chinese + English: never vocabulary. */
const HEADINGS = new Set([
  '課文', '生詞', '短語', '專有名詞', '補充生詞', '語法', '綜合活動', '語音', '文化', '複習', '練習', '附錄', '文化小知識',
]);

/** Ruby duplicates (名字子), alternates (她/他) and a part of speech stuck to the gloss ("N name"). */
export function cleanCandidate(c: RawCandidate): RawCandidate | undefined {
  const forms = c.headword.split(/[/／]/).filter(Boolean);
  const syll = c.pinyin ? syllables(c.pinyin.split('/')[0]!) : 0;
  const [first = '', ...rest] = forms.map((f, i) => (i === 0 && syll ? dedupeRuby(f, syll) : f));
  if (!first || HEADINGS.has(first)) return undefined;
  const toks = c.glossEn.split(/\s+/).filter(Boolean);
  while (toks.length > 1 && toks[0]!.split('/').every((t) => POS_TAGS.has(t))) toks.shift();
  return { ...c, headword: first, variants: rest, glossEn: toks.join(' ') };
}

/** Candidates of one page from both passes, layout first (its rows carry the table/label kind). */
export function scanPage(layout: string, text: string): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const raw of [...scanLayoutPage(layout), ...scanBlockPage(text)]) {
    const c = cleanCandidate(raw);
    if (!c || seen.has(c.headword)) continue;
    seen.add(c.headword);
    out.push(c);
  }
  return out;
}

/** Short Chinese-only lines that no candidate explains: a hint that a page's labels are pictures. */
export function bareLabels(text: string, covered: Set<string>): string[] {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    const t = l.trim();
    if (ZH_ONLY.test(t) && t.length >= 2 && t.length <= 6 && !covered.has(t) && !HEADINGS.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

/** A candidate that is new: not already a word of this or an earlier lesson, and not a name. */
export function newCandidates(cands: RawCandidate[], knownForms: ReadonlySet<string>): RawCandidate[] {
  return cands.filter((c) => !c.proper && ![c.headword, ...c.variants].some((f) => knownForms.has(f)));
}
