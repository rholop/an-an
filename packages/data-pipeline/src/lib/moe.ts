import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  normalizePinyinText,
  parseSyllableTone,
  pickHeteronymReading,
  pinyinToZhuyin,
  toPinyinNumeric,
} from '@anan/core';

export interface MoeDefinition {
  def: string;
  type?: string;
}
export interface MoeHeteronym {
  pinyin?: string;
  bopomofo?: string;
  definitions?: MoeDefinition[];
}
export interface MoeEntry {
  title: string;
  heteronyms?: MoeHeteronym[];
  English?: string;
  translation?: { English?: string[] };
}

export class MoeDictionary {
  private readonly byTitle = new Map<string, MoeEntry>();

  private constructor(entries: MoeEntry[]) {
    for (const e of entries) {
      // A handful of MOE titles are unencoded/placeholder glyphs like
      // "{[8ff0]}" for characters missing from the source font — useless as
      // a lookup key and never a valid TOCFL headword, so skip them.
      if (!e.title || e.title.startsWith('{[')) continue;
      // Keep the first entry for a given title (MOE data has no duplicate
      // titles in practice); later dupes would just be noise.
      if (!this.byTitle.has(e.title)) this.byTitle.set(e.title, e);
    }
  }

  static loadFromXz(path: string): MoeDictionary {
    // data-pipeline is an offline Node build tool (not packages/core), so
    // shelling out to the system `unxz` binary is the simplest way to read
    // this without adding an xz/lzma npm dependency.
    const json = execFileSync('unxz', ['-c', path], {
      maxBuffer: 1024 * 1024 * 1024,
      encoding: 'utf8',
    });
    return new MoeDictionary(JSON.parse(json) as MoeEntry[]);
  }

  /** Load from an already-decompressed JSON file (see build-lexicon.ts's
   * data/raw/.cache — re-running `unxz` on every build is wasteful). */
  static loadFromJsonFile(path: string): MoeDictionary {
    const json = readFileSync(path, 'utf8');
    return new MoeDictionary(JSON.parse(json) as MoeEntry[]);
  }

  /** Test-only: build a dictionary from in-memory entries instead of a real
   * MOE data file. */
  static fromEntries(entries: MoeEntry[]): MoeDictionary {
    return new MoeDictionary(entries);
  }

  get size(): number {
    return this.byTitle.size;
  }

  entry(title: string): MoeEntry | undefined {
    return this.byTitle.get(title);
  }

  /** All titles, for the compound scan in build-lexicon. */
  titles(): IterableIterator<string> {
    return this.byTitle.keys();
  }

  gloss(title: string): string | undefined {
    const e = this.byTitle.get(title);
    if (!e) return undefined;
    if (e.English) return e.English;
    if (e.translation?.English?.length) return e.translation.English.join('; ');
    return undefined;
  }
}

export interface ResolvedReading {
  pinyin: string;
  zhuyin: string;
  /** How the reading was obtained, most-authoritative first. Recorded on
   * Word.tags so the review report / a human can audit any given entry. */
  source: 'moe-phrase' | 'moe-composed' | 'zhuyin-derived' | 'tocfl-unverified';
  mismatch?: { tocflPinyin: string; moePinyin: string };
}

function tonelessCompact(pinyin: string): string {
  return normalizePinyinText(pinyin)
    .split(/\s+/)
    .map((syl) => parseSyllableTone(syl).base.toLowerCase())
    .join('');
}

// MOE frequently encodes "this character is just a variant glyph of X" as a
// heteronym with NO pinyin/bopomofo and a single definition reading exactly
// "「X」的異體字。" (e.g. 台 -> 臺, 唇 -> 脣, 樑 -> 梁, 艷 -> 豔, 裏 -> 裡).
// The real, modern-Taiwan reading lives under X's own entry — chasing this
// redirect is how e.g. 台灣/舞台/月台 get "tái" instead of 台's own rare
// classical readings (tāi/yí). Depth-limited in case of a redirect cycle.
const VARIANT_OF_RE = /^「(.+?)」(?:的異體字|為.+?異體字)。?$/;

function findVariantTarget(h: MoeHeteronym): string | undefined {
  if (h.pinyin) return undefined;
  const def = h.definitions?.[0]?.def;
  return def ? (def.match(VARIANT_OF_RE)?.[1] ?? undefined) : undefined;
}

/** Every heteronym usable as a real reading for `title`, chasing variant
 * redirects first (they're the common modern reading in every case we've
 * found) and falling back to the entry's own non-stub heteronyms. */
function effectiveHeteronyms(moe: MoeDictionary, title: string, depth = 0): MoeHeteronym[] {
  const entry = moe.entry(title);
  if (!entry?.heteronyms?.length) return [];

  const redirected: MoeHeteronym[] = [];
  if (depth < 3) {
    for (const h of entry.heteronyms) {
      const target = findVariantTarget(h);
      if (target && target !== title) redirected.push(...effectiveHeteronyms(moe, target, depth + 1));
    }
  }
  const own = entry.heteronyms.filter((h) => h.pinyin);
  return [...redirected, ...own];
}

/**
 * Pick whichever candidate's pinyin is consistent with the TOCFL-provided
 * reading for this word. TOCFL pinyin often has no inter-syllable spaces
 * (e.g. "cóngbù"), so we can't split it into aligned syllables in general —
 * but a candidate's *toned* syllable ("cóng") still reliably turns up as a
 * literal substring of the concatenated string when it's the right one, so
 * try that (tone-sensitive) before falling back to a toneless match (which
 * can still pick the wrong tone among same-base candidates, e.g. cōng vs
 * cóng — an acceptable residual gap given TOCFL's pinyin cell alone doesn't
 * let us do better without a full syllable segmenter).
 */
function pickBySubstring(candidates: MoeHeteronym[], tocflPinyinNormalized: string): MoeHeteronym | undefined {
  const haystack = tocflPinyinNormalized.toLowerCase().replace(/\s+/g, '');
  const toned = candidates.find((h) => h.pinyin && haystack.includes(normalizePinyinText(h.pinyin).toLowerCase()));
  if (toned) return toned;
  const tonelessHaystack = tonelessCompact(tocflPinyinNormalized);
  return candidates.find((h) => h.pinyin && tonelessHaystack.includes(parseSyllableTone(h.pinyin).base.toLowerCase()));
}

/** Pick the heteronym whose pinyin best matches the TOCFL-provided reading,
 * for the rare fixed phrase/title that MOE itself lists as ambiguous. */
function pickBestHeteronym(heteronyms: MoeHeteronym[], tocflPinyin: string): MoeHeteronym {
  if (heteronyms.length === 1) return heteronyms[0]!;
  // Tone-sensitive exact match FIRST: two heteronyms can share the same
  // toneless base (上: shǎng vs shàng both -> "shang") and differ only by
  // tone, so a toneless-only comparison can't tell them apart and would
  // just return whichever MOE happens to list first (see 兒/從 bugs above,
  // same root cause) — always prefer an exact, tone-included match.
  const tonedTarget = normalizePinyinText(tocflPinyin).toLowerCase().replace(/\s+/g, '');
  const tonedExact = heteronyms.find(
    (h) => h.pinyin && normalizePinyinText(h.pinyin).toLowerCase().replace(/\s+/g, '') === tonedTarget,
  );
  if (tonedExact) return tonedExact;

  const target = tonelessCompact(tocflPinyin);
  const exact = heteronyms.find((h) => h.pinyin && tonelessCompact(h.pinyin) === target);
  if (exact) return exact;
  return pickBySubstring(heteronyms, tocflPinyin) ?? heteronyms[0]!;
}

/**
 * Resolve pinyin+zhuyin for one (headword, TOCFL-pinyin) pair against MOE,
 * per phase doc §"Reading verification": prefer MOE's reading and record
 * any mismatch; derive zhuyin from MOE, not the converter, wherever MOE has
 * the word (as a fixed phrase, or composed from its individual characters);
 * only the pinyin→zhuyin converter is used when MOE has no entry at all for
 * a character.
 */
export function resolveMoeReading(moe: MoeDictionary, headword: string, tocflPinyinRaw: string): ResolvedReading {
  const tocflPinyin = normalizePinyinText(tocflPinyinRaw);

  const directCandidates = moe.entry(headword) ? effectiveHeteronyms(moe, headword) : [];
  if (directCandidates.length > 0) {
    const chosen = pickBestHeteronym(directCandidates, tocflPinyin);
    const moePinyin = normalizePinyinText(chosen.pinyin ?? '');
    const moeZhuyin = chosen.bopomofo ?? '';
    const result: ResolvedReading = { pinyin: moePinyin, zhuyin: moeZhuyin, source: 'moe-phrase' };
    if (tocflPinyin && tonelessCompact(tocflPinyin) !== tonelessCompact(moePinyin)) {
      result.mismatch = { tocflPinyin, moePinyin };
    }
    return result;
  }

  // Not a fixed MOE title (typical for multi-character compounds the TOCFL
  // list has but MOE's headword-style dictionary doesn't list on its own,
  // e.g. some proper nouns / newer coinages) — compose per character.
  const chars = [...headword];
  const pinyinParts: string[] = [];
  const zhuyinParts: string[] = [];
  let anyDerived = false;
  let anyUnavailable = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const candidates = effectiveHeteronyms(moe, ch);
    if (candidates.length === 0) {
      anyUnavailable = true;
      pinyinParts.push('?');
      zhuyinParts.push('?');
      continue;
    }
    let chosen = candidates[0]!;
    if (candidates.length > 1) {
      // Erhua (兒 as a bound suffix, e.g. 畫兒 huàr) is a phonological fusion,
      // not a second syllable — 兒's own "r" never surfaces as a separate
      // sound, so no substring of the word's pinyin can ever match a
      // candidate reading for it. Special-case: a trailing 兒 whose word
      // pinyin ends in a bare "r" is always the ér reading, never MOE's
      // rarer literal readings (ní, as a surname; etc.).
      const isErhuaSuffix =
        ch === '兒' && i === chars.length - 1 && /r$/i.test(tonelessCompact(tocflPinyin));
      const erhua = isErhuaSuffix ? candidates.find((h) => h.pinyin && parseSyllableTone(h.pinyin).base === 'er') : undefined;

      const picked = pickHeteronymReading(
        ch,
        { before: chars[i - 1], after: chars[i + 1] },
        candidates.map((h) => ({ pinyinBaseNumeric: toPinyinNumeric(h.pinyin!).split(' ')[0] ?? '', h })),
      );
      chosen =
        erhua ?? (picked && picked.confidence !== 'low' ? picked.candidate.h : (pickBySubstring(candidates, tocflPinyin) ?? chosen));
    }
    pinyinParts.push(normalizePinyinText(chosen.pinyin ?? '?'));
    if (chosen.bopomofo) {
      zhuyinParts.push(chosen.bopomofo);
    } else {
      anyDerived = true;
      zhuyinParts.push(pinyinToZhuyin(chosen.pinyin ?? ''));
    }
  }

  if (anyUnavailable) {
    return { pinyin: tocflPinyin, zhuyin: '', source: 'tocfl-unverified' };
  }

  const composedPinyin = pinyinParts.join(' ');
  const result: ResolvedReading = {
    pinyin: composedPinyin,
    zhuyin: zhuyinParts.join(' '),
    source: anyDerived ? 'zhuyin-derived' : 'moe-composed',
  };
  if (tocflPinyin && tonelessCompact(tocflPinyin) !== tonelessCompact(composedPinyin)) {
    result.mismatch = { tocflPinyin, moePinyin: composedPinyin };
  }
  return result;
}
