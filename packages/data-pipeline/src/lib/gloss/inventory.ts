import type { SenseCandidate, Word } from '@anan/core';
import type { MoeDictionary } from '../moe.js';
import { parseGloss, pinyinKey } from './normalize.js';
import {
  cedictOtherReadingSenses,
  cedictSensesFor,
  top2011For,
  type CedictRow,
  type TopEntry,
  type WiktionarySense,
} from './sources.js';

export interface GlossSources {
  cedict: Map<string, CedictRow[]>;
  top2011: Map<string, TopEntry[]>;
  moe: MoeDictionary;
  wiktionary?: Map<string, WiktionarySense[]>;
}

export interface SenseInventory {
  candidates: SenseCandidate[];
  /** MOE definition text for this reading, verbatim (CC BY-ND). */
  moeDefsZh: string[];
  /** Terse 2011 glosses, the tie-breaker for "which sense did the list mean". */
  top2011: string[];
}

const MAX_CANDIDATES = 24;
const MAX_MOE_DEFS = 6;

function wiktionaryTags(raw: string[]): string[] {
  const tags = new Set<string>();
  for (const t of raw.map((r) => r.toLowerCase())) {
    if (t.includes('taiwan')) tags.add('taiwan');
    else if (t.includes('mainland')) tags.add('mainland');
    else if (/colloquial|slang|vulgar|informal|dialect/.test(t)) tags.add('informal');
    else if (/literary|archaic|dated|obsolete/.test(t)) tags.add('literary');
    else tags.add(t);
  }
  return [...tags];
}

/** Pulls every candidate sense for one word from every available source,
 * normalised to {source, pos, glossEn | defZh, tags} (phase doc B1). */
export function buildInventory(
  word: Pick<Word, 'headword' | 'variants' | 'pinyin' | 'pos'>,
  src: GlossSources,
): SenseInventory {
  const spellings = [word.headword, ...word.variants];
  const key = pinyinKey(word.pinyin);
  const candidates: Omit<SenseCandidate, 'id'>[] = [];

  // CC-CEDICT (per reading).
  const cedictRows = spellings.flatMap((s) => src.cedict.get(s) ?? []);
  const cedictSenses = cedictSensesFor(cedictRows, word.pinyin);
  for (const raw of cedictSenses) {
    const g = parseGloss(raw);
    if (!g.junk) candidates.push({ source: 'cedict', glossEn: g.text, tags: g.tags });
  }

  // Other readings' senses, low priority: only when this reading has none, or
  // for measure words (the list's reading can differ from CEDICT's).
  const isMeasure = word.pos.some((p) => p === 'M' || p === 'Msr');
  if (cedictSenses.length === 0 || isMeasure) {
    for (const raw of cedictOtherReadingSenses(cedictRows, word.pinyin)) {
      const g = parseGloss(raw);
      if (!g.junk && (cedictSenses.length === 0 || /dozen|classifier|measure word/i.test(g.text))) {
        candidates.push({ source: 'cedict', glossEn: g.text, tags: [...g.tags, 'other-reading'] });
      }
    }
  }

  // MOE's bundled English (CEDICT-derived, merged across readings): only when
  // the per-reading source had nothing, and labelled as reading-unverified.
  if (candidates.every((c) => c.source !== 'cedict')) {
    const entry = src.moe.entry(word.headword);
    for (const raw of entry?.translation?.English ?? []) {
      const g = parseGloss(raw);
      if (!g.junk)
        candidates.push({
          source: 'moe-cedict',
          glossEn: g.text,
          tags: [...g.tags, 'reading-unverified'],
        });
    }
  }

  // Wiktionary (optional dump).
  for (const s of spellings.flatMap((sp) => src.wiktionary?.get(sp) ?? [])) {
    if (s.pinyinKeys.length > 0 && !s.pinyinKeys.includes(key)) continue;
    const g = parseGloss(s.glosses[0]!);
    if (!g.junk)
      candidates.push({
        source: 'wiktionary',
        pos: s.pos || undefined,
        glossEn: g.text,
        tags: [...new Set([...wiktionaryTags(s.tags), ...g.tags])],
      });
  }

  // Old TOP terse glosses.
  const top = spellings.flatMap((sp) => top2011For(src.top2011.get(sp), word.pinyin));
  for (const t of top)
    candidates.push({ source: 'top2011', pos: t.pos || undefined, glossEn: t.meaning, tags: [] });

  // MOE Chinese definitions for this reading (ground truth for which senses
  // exist in Taiwan; shown verbatim, so only whole definitions are kept).
  const moeEntry = src.moe.entry(word.headword);
  const het = moeEntry?.heteronyms?.find(
    (h) => h.pinyin && pinyinKey(h.pinyin.replace(/[（(].*?[）)]/g, '')) === key,
  );
  const moeDefsZh = (het?.definitions ?? [])
    .map((d) => d.def)
    .filter(Boolean)
    .slice(0, MAX_MOE_DEFS);
  for (const d of moeDefsZh) candidates.push({ source: 'moe-zh', defZh: d, tags: [] });

  // Drop mainland-only senses when a non-mainland alternative exists.
  const alternatives = candidates.some((c) => c.glossEn && !c.tags.includes('mainland'));
  const filtered = alternatives
    ? candidates.filter((c) => !(c.tags.includes('mainland') && !c.tags.includes('taiwan')))
    : candidates;

  const unique: Omit<SenseCandidate, 'id'>[] = [];
  const seen = new Set<string>();
  for (const c of filtered) {
    const k = `${c.source}|${(c.glossEn ?? c.defZh ?? '').toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
  }
  const limited = unique.slice(0, MAX_CANDIDATES);
  return {
    candidates: limited.map((c, i) => ({ ...c, id: `c${i + 1}` })),
    moeDefsZh,
    top2011: top.map((t) => t.meaning),
  };
}
