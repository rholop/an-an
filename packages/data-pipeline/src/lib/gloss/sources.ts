import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseCsv } from './csv.js';
import { pinyinKey, splitOutsideParens } from './normalize.js';

/** One reading's English senses, as CC-CEDICT words them (via ivankra/tocfl's
 * tocfl-cedict.csv — CC-CEDICT definitions merged onto the TOCFL list). */
export interface CedictReading {
  pinyinKey: string;
  senses: string[];
}

export interface CedictRow {
  id: string;
  headwords: string[];
  pinyinKey: string;
  pos: string;
  readings: CedictReading[];
}

/** "[hái] still/yet<br> [huán] to return" -> readings. A first line with no
 * [pinyin] belongs to the row's own reading. */
export function parseCedictMeaning(meaning: string, rowPinyin: string): CedictReading[] {
  const readings: CedictReading[] = [];
  for (const line of meaning.split(/<br\s*\/?>/i)) {
    const m = /^\s*(?:[^\s[]+\s+)?\[([^\]]+)\]\s*(.*)$/s.exec(line);
    const pinyin = m ? m[1]! : rowPinyin;
    const body = m ? m[2]! : line;
    const senses = splitOutsideParens(body, '/');
    if (senses.length > 0) readings.push({ pinyinKey: pinyinKey(pinyin), senses });
  }
  return readings;
}

export function loadTocflCedict(path: string): Map<string, CedictRow[]> {
  const index = new Map<string, CedictRow[]>();
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const headwords = r
      .Traditional!.split('/')
      .map((h) => h.replace(/[()（）]/g, '').trim())
      .filter(Boolean);
    const row: CedictRow = {
      id: r.ID!,
      headwords,
      pinyinKey: pinyinKey(r.Pinyin ?? ''),
      pos: r.POS ?? '',
      readings: parseCedictMeaning(r.Meaning ?? '', r.Pinyin ?? ''),
    };
    for (const h of headwords) {
      const list = index.get(h) ?? [];
      list.push(row);
      index.set(h, list);
    }
  }
  return index;
}

export interface TopEntry {
  id: string;
  pinyinKey: string;
  pos: string;
  meaning: string;
}

/** Old (2010–2011) SC-TOP terse glosses — build-time hint only (licence unclear). */
export function loadTop2011(path: string): Map<string, TopEntry[]> {
  const index = new Map<string, TopEntry[]>();
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const entry: TopEntry = {
      id: r.ID!,
      pinyinKey: pinyinKey(r.Pinyin ?? ''),
      pos: r.POS ?? '',
      meaning: r.Meaning ?? '',
    };
    for (const h of r
      .Traditional!.split('/')
      .map((x) => x.replace(/[()（）]/g, '').trim())
      .filter(Boolean)) {
      const list = index.get(h) ?? [];
      list.push(entry);
      index.set(h, list);
    }
  }
  return index;
}

/** CEDICT senses for one Word: lines whose pinyin matches the word's reading,
 * across every row of that headword (the same reading appears under several
 * POS rows, so dedupe). Falls back to the row's own reading, then to any. */
export function cedictSensesFor(rows: CedictRow[] | undefined, wordPinyin: string): string[] {
  if (!rows || rows.length === 0) return [];
  const key = pinyinKey(wordPinyin);
  const exact: string[] = [];
  for (const row of rows)
    for (const reading of row.readings)
      if (reading.pinyinKey === key) exact.push(...reading.senses);
  const seen = new Set<string>();
  const dedupe = (list: string[]) =>
    list.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  if (exact.length > 0) return dedupe(exact);
  const own = rows.filter((r) => r.pinyinKey === key).flatMap((r) => r.readings[0]?.senses ?? []);
  return dedupe(own);
}

/** Senses of the headword's OTHER readings — a deliberate last resort (used
 * when the word's own reading has none, or for measure words whose list
 * reading differs from CEDICT's, e.g. 打 dozen). Always tagged by callers. */
export function cedictOtherReadingSenses(
  rows: CedictRow[] | undefined,
  wordPinyin: string,
): string[] {
  if (!rows) return [];
  const key = pinyinKey(wordPinyin);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const reading of row.readings) {
      if (reading.pinyinKey === key) continue;
      for (const s of reading.senses) {
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

export function top2011For(entries: TopEntry[] | undefined, wordPinyin: string): TopEntry[] {
  if (!entries) return [];
  const key = pinyinKey(wordPinyin);
  const exact = entries.filter((e) => e.pinyinKey === key);
  return exact.length > 0 ? exact : [];
}

// ---------- Optional heavy sources (skipped when the raw file is absent) ----------

export interface WiktionarySense {
  pos: string;
  glosses: string[];
  tags: string[];
  pinyinKeys: string[];
}

/** Wiktionary sense tags that make a sense wrong to teach from a Taiwan
 * Mandarin word list: slang/joke senses (衣服 "ecstasy", 唱歌 "to urinate"),
 * literal readings of set phrases (再見 "to meet again"), Classical Chinese,
 * other Sinitic languages and other regions' usage. Matched case-insensitively
 * against whole tags. */
const WIKTIONARY_REJECT_TAGS = new Set(
  [
    'slang',
    'vulgar',
    'euphemistic',
    'neologism',
    'humorous',
    'internet',
    'internet-slang',
    'derogatory',
    'offensive',
    'ironic',
    'Classical',
    'Classical-Chinese',
    'Literary-Chinese',
    'obsolete',
    'archaic',
    'proscribed',
    'no-gloss',
    'in gacha games',
    'Cantonese',
    'Hokkien',
    'Taiwanese-Hokkien',
    'Wu',
    'Min',
    'Min-Nan',
    'Min-Bei',
    'Min-Dong',
    'Hakka',
    'Teochew',
    'Shanghainese',
    'Sichuanese',
    'Xiang',
    'Gan',
    'Jin',
    'Dungan',
    'Jianghuai-Mandarin',
    'Southwestern-Mandarin',
    'Northeastern-Mandarin',
    'Beijing',
    'Hong-Kong',
    'Macau',
    'Singapore',
    'Malaysia',
    'Philippines',
    'Canada',
    'Japan',
    'Korea',
  ].map((t) => t.toLowerCase()),
);
/** Proper-name senses that are not the word's meaning ("a surname",
 * "Xingxing (a community in … Hubei, China)"). */
const NAME_JUNK =
  /\b(?:surname|given name|(?:town|township|village|community|subdistrict|county|district|prefecture|river|mountain|railway station) (?:in|of)\b)/i;

/** Capitalised openers of Wiktionary's sentence-style glosses (not proper
 * nouns like "Chinese", "Spanish", which keep their capital). */
const SENTENCE_OPENER =
  /^(?:Used|Final|Modal|Classifier|Alternative|Sentence-final|Particle|Suffix|Prefix|Diminutive|Indicates|Describes|Denotes|Emphatic|Term|Short|Only|Sound|General|Any|An?|The|One|To|It|If|When|What)\b/;

/** Wiktionary's wording, tidied to CEDICT's shape: no "(Classifier: …)" tail,
 * no sentence capital or full stop ("Classifier for years." → "classifier for
 * years"). Proper nouns keep their capital. */
export function tidyWiktionaryGloss(gloss: string): string {
  let g = gloss
    .replace(/\s*\((?:Classifier|classifier)s?:[^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/\.$/, '');
  if (SENTENCE_OPENER.test(g)) g = g[0]!.toLowerCase() + g.slice(1);
  return g;
}

/** Whether one Wiktionary sense is usable at all (see WIKTIONARY_REJECT_TAGS). */
export function isUsableWiktionarySense(gloss: string, tags: string[]): boolean {
  if (tags.some((t) => WIKTIONARY_REJECT_TAGS.has(t.toLowerCase()))) return false;
  // A literal reading of a set phrase alone (再見 "to meet again") is not its
  // meaning; "literally and figuratively" (污染 "to pollute") is.
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.includes('literally') && !lower.includes('figuratively')) return false;
  if (NAME_JUNK.test(gloss)) return false;
  return gloss.length > 0;
}

/** Tags a standard-Mandarin pinyin sound may carry; anything else (Chengdu,
 * Xi'an, Dungan, Cantonese…) is another variety's reading. */
const STANDARD_PINYIN_TAGS = new Set([
  'Mandarin',
  'Standard',
  'Standard-Chinese',
  'Pinyin',
  'Taiwan',
  'Mainland',
  'Mainland-China',
]);

/** The standard-Mandarin pinyin of one wiktextract sound, e.g.
 * {zh_pron: "zhà (zha⁴)", tags: ["Mandarin", "Pinyin"]} -> "zhà (zha⁴)". */
function standardPinyin(s: WiktionarySound): string | undefined {
  if (s.zh_pron !== undefined) {
    const tags = s.tags ?? [];
    return tags.includes('Pinyin') &&
      tags.includes('Mandarin') &&
      tags.every((t) => STANDARD_PINYIN_TAGS.has(t))
      ? s.zh_pron
      : undefined;
  }
  return s['zh-pron'] ?? s.pinyin; // older wiktextract shape
}

interface ParsedEntry {
  word: string;
  senses: WiktionarySense[];
  redirects: string[];
}

function parseWiktionaryLine(line: string, wanted: (w: string) => boolean): ParsedEntry | null {
  if (!line) return null;
  // Cheap pre-filter: every line starts with {"word": "…" — skip JSON.parse
  // for the ≈99% of the dump that isn't wanted.
  const head = /^\{"word": ?"([^"]+)"/.exec(line);
  if (head && !wanted(head[1]!)) return null;
  let entry: WiktionaryEntry;
  try {
    entry = JSON.parse(line) as WiktionaryEntry;
  } catch {
    return null;
  }
  if (!entry.word || !wanted(entry.word)) return null;
  const pos = entry.pos ?? '';
  const pinyinKeys = [
    ...new Set(
      (entry.sounds ?? [])
        .map(standardPinyin)
        .filter((p): p is string => typeof p === 'string')
        .map((p) => pinyinKey(p.replace(/\s*\(.*\)\s*$/, ''))),
    ),
  ];
  const senses: WiktionarySense[] = [];
  for (const s of entry.senses ?? []) {
    const tags = [...(s.tags ?? []), ...(s.raw_tags ?? [])];
    const glosses = (s.glosses ?? []).map((g) => tidyWiktionaryGloss(g)).filter(Boolean);
    if (glosses.length === 0 || !isUsableWiktionarySense(glosses[0]!, tags)) continue;
    senses.push({ pos, glosses, tags, pinyinKeys });
  }
  return { word: entry.word, senses, redirects: entry.redirects ?? [] };
}

async function* lines(path: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

/**
 * Streams the kaikki.org/wiktextract Chinese JSONL dump (≈1 GB — never loaded
 * whole) and keeps only entries for `wanted` headwords. Returns [] sources
 * when the file isn't downloaded; see data/raw/SOURCES.md.
 *
 * Taiwan spellings are often "soft-redirect" entries with no senses of their
 * own (汙染 → 污染, 月台 → 月臺, 吸菸 → 吸煙); a second pass fetches the
 * redirect targets and files their senses under the wanted spelling.
 */
export async function loadWiktionary(
  path: string,
  wanted: ReadonlySet<string>,
): Promise<Map<string, WiktionarySense[]>> {
  const out = new Map<string, WiktionarySense[]>();
  if (!existsSync(path)) return out;
  const add = (word: string, senses: WiktionarySense[]) => {
    if (senses.length > 0) out.set(word, [...(out.get(word) ?? []), ...senses]);
  };

  const redirects = new Map<string, string[]>(); // wanted word -> targets
  for await (const line of lines(path)) {
    const e = parseWiktionaryLine(line, (w) => wanted.has(w));
    if (!e) continue;
    add(e.word, e.senses);
    if (e.redirects.length > 0) redirects.set(e.word, e.redirects);
  }

  const pending = [...redirects].filter(([w]) => !out.has(w));
  if (pending.length === 0) return out;
  const targets = new Set(pending.flatMap(([, ts]) => ts));
  const found = new Map<string, WiktionarySense[]>();
  for await (const line of lines(path)) {
    const e = parseWiktionaryLine(line, (w) => targets.has(w));
    if (e && e.senses.length > 0) found.set(e.word, [...(found.get(e.word) ?? []), ...e.senses]);
  }
  for (const [word, ts] of pending) {
    const first = ts.find((t) => found.has(t));
    if (first) add(word, found.get(first)!);
  }
  return out;
}

interface WiktionarySound {
  zh_pron?: string;
  'zh-pron'?: string;
  pinyin?: string;
  tags?: string[];
}

interface WiktionaryEntry {
  word?: string;
  pos?: string;
  redirects?: string[];
  sounds?: WiktionarySound[];
  senses?: { glosses?: string[]; tags?: string[]; raw_tags?: string[] }[];
}

/** Unihan per-character definitions (kDefinition) from Unihan_Readings.txt,
 * for the character-breakdown leech treatment. Empty if not downloaded. */
export function loadUnihanDefinitions(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^U\+([0-9A-F]+)\tkDefinition\t(.+)$/.exec(line);
    if (m) out.set(String.fromCodePoint(parseInt(m[1]!, 16)), m[2]!.trim());
  }
  return out;
}
