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

/**
 * Streams the kaikki.org/wiktextract Chinese JSONL dump (≈1 GB — never loaded
 * whole) and keeps only entries for `wanted` headwords. Returns [] sources
 * when the file isn't downloaded; see data/raw/SOURCES.md.
 */
export async function loadWiktionary(
  path: string,
  wanted: ReadonlySet<string>,
): Promise<Map<string, WiktionarySense[]>> {
  const out = new Map<string, WiktionarySense[]>();
  if (!existsSync(path)) return out;
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let entry: WiktionaryEntry;
    try {
      entry = JSON.parse(line) as WiktionaryEntry;
    } catch {
      continue;
    }
    if (!entry.word || !wanted.has(entry.word)) continue;
    const pinyinKeys = (entry.sounds ?? [])
      .map((s) => s['zh-pron'] ?? s.pinyin)
      .filter((p): p is string => typeof p === 'string')
      .map(pinyinKey);
    for (const s of entry.senses ?? []) {
      const glosses = (s.glosses ?? []).filter(Boolean);
      if (glosses.length === 0) continue;
      const list = out.get(entry.word) ?? [];
      list.push({
        pos: entry.pos ?? '',
        glosses,
        tags: [...(s.tags ?? []), ...(s.raw_tags ?? [])],
        pinyinKeys,
      });
      out.set(entry.word, list);
    }
  }
  return out;
}

interface WiktionaryEntry {
  word?: string;
  pos?: string;
  sounds?: { 'zh-pron'?: string; pinyin?: string }[];
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
