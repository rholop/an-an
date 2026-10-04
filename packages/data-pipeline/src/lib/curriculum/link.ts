import type { Lexicon, Word } from '@anan/core';
import type { BookWord } from './vocab-parse.js';

/** Lowercase, drop spaces / apostrophes / hyphens; keep tone marks. */
export function normPinyin(p: string): string {
  return p
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s’'\-.?!,]/g, '')
    .replace(/\(.*?\)/g, '');
}

/** Same but with tone marks and ü stripped. */
export function tonelessPinyin(p: string): string {
  return normPinyin(p).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'u');
}

/** `bú / bù`, `nǎlǐ (nǎr)` → each acceptable reading. */
export function pinyinOptions(p: string): string[] {
  const paren = p.match(/^(.*?)\s*\((.*)\)\s*$/);
  const parts = (paren ? [paren[1]!, paren[2]!] : [p]).flatMap((x) => x.split('/'));
  return parts.map((x) => x.trim()).filter(Boolean);
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'and',
  'or',
  'be',
  'is',
  'for',
  'at',
  'one',
]);

function glossTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
      .map((t) => t.replace(/s$/, '')),
  );
}

/** Share of the book gloss's content words found in a Word's glosses. */
export function glossOverlap(bookGloss: string, w: Word): number {
  const book = glossTokens(bookGloss);
  if (book.size === 0) return 0;
  // The book's own sense (added by build-lexicon) must not influence linking, or a re-run would be self-confirming.
  const hay = glossTokens(
    [
      w.glossEn,
      ...(w.senses ?? []).filter((s) => !s.basedOn.includes('textbook')).map((s) => s.glossEn),
    ].join(' '),
  );
  let hit = 0;
  for (const t of book) if (hay.has(t)) hit++;
  return hit / book.size;
}

export interface LinkResult {
  word?: Word;
  /** How the match was made. */
  tier: 'exact' | 'toneless' | 'headword-only' | 'none';
  overlap: number;
}

const LEVEL_PENALTY: Record<string, number> = { N1: 0, N2: 1, L1: 2, L2: 3, L3: 4, L4: 5, L5: 6 };

/**
 * Pick the lexicon entry for a book word: headword/variant, then reading
 * (exact tones > toneless > none), then the sense whose gloss best matches
 * the book's English, then the lowest level.
 */
export function linkBookWord(bw: BookWord, lexicon: Lexicon): LinkResult {
  const forms = [bw.headword, ...bw.variants];
  const seen = new Set<string>();
  const candidates: Word[] = [];
  for (const f of forms) {
    for (const w of lexicon.lookup(f)) {
      if (!seen.has(w.id) && w.source !== 'textbook') {
        seen.add(w.id);
        candidates.push(w);
      }
    }
  }
  if (candidates.length === 0) return { tier: 'none', overlap: 0 };
  const opts = pinyinOptions(bw.pinyin);
  const exact = new Set(opts.map(normPinyin));
  const toneless = new Set(opts.map(tonelessPinyin));
  const scored = candidates.map((w) => {
    const tier: LinkResult['tier'] = exact.has(normPinyin(w.pinyin))
      ? 'exact'
      : toneless.has(tonelessPinyin(w.pinyin))
        ? 'toneless'
        : 'headword-only';
    const overlap = glossOverlap(bw.glossEn, w);
    const posBonus = bw.pos.some((p) => w.pos.includes(p)) ? 0.15 : 0;
    const tierScore = tier === 'exact' ? 2 : tier === 'toneless' ? 1 : 0;
    const level = w.level ? (LEVEL_PENALTY[w.level] ?? 7) : 8;
    // Prefer the real TOCFL entry over a lookup-only compound for the same form.
    const sourceBonus = w.source === 'tocfl' ? 2 : 0;
    return {
      w,
      tier,
      overlap,
      score: tierScore * 10 + sourceBonus + overlap * 3 + posBonus * 3 - level * 0.05,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.w.id.localeCompare(b.w.id));
  const best = scored[0]!;
  // A headword whose reading differs by more than tone is a different word
  // (homograph, or a longer lexicon entry listing the form as a variant):
  // treat as unlinked so the book's own entry is created.
  if (best.tier === 'headword-only') return { tier: 'none', overlap: best.overlap };
  return { word: best.w, tier: best.tier, overlap: best.overlap };
}

/**
 * Other written forms the book gives for a word that are separate lexicon
 * entries with an acceptable reading (她/他, 臺灣/台灣, 你/妳). They are taught
 * together, so they join the same lesson.
 */
export function linkVariantForms(bw: BookWord, lexicon: Lexicon, primary: Word): Word[] {
  const primaryId = primary.id;
  const primaryForms = new Set([primary.headword, ...primary.variants]);
  const opts = new Set(pinyinOptions(bw.pinyin).map(normPinyin));
  const out: Word[] = [];
  for (const form of [bw.headword, ...bw.variants]) {
    if (primaryForms.has(form)) continue;
    const matches = lexicon
      .lookup(form)
      .filter(
        (w) => w.id !== primaryId && w.source !== 'textbook' && opts.has(normPinyin(w.pinyin)),
      );
    const best = matches.sort(
      (a, b) => (a.source === 'tocfl' ? 0 : 1) - (b.source === 'tocfl' ? 0 : 1),
    )[0];
    if (best && !out.some((o) => o.id === best.id)) out.push(best);
  }
  return out;
}
