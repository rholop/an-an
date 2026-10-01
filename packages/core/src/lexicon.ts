import type { GrammarItem, Level, Word } from './types.js';

export interface LexiconMeta {
  version: string;
  buildDate: string;
  sourceHashes: Record<string, string>;
}

/**
 * In-memory index over the built lexicon. Pure data structure — no fetch, no
 * fs. Callers (data-pipeline at build time, apps/web at load time) hand it
 * already-parsed Word[]/GrammarItem[].
 */
export class Lexicon {
  private readonly wordsById = new Map<string, Word>();
  private readonly wordsByHeadword = new Map<string, Word[]>();
  private readonly grammarById = new Map<string, GrammarItem>();
  private readonly maxWordLen: number;

  constructor(
    words: Word[],
    grammar: GrammarItem[] = [],
    public readonly meta?: LexiconMeta,
  ) {
    let maxLen = 1;
    for (const w of words) {
      this.wordsById.set(w.id, w);
      for (const headform of [w.headword, ...w.variants]) {
        const list = this.wordsByHeadword.get(headform);
        if (list) list.push(w);
        else this.wordsByHeadword.set(headform, [w]);
        maxLen = Math.max(maxLen, [...headform].length);
      }
    }
    for (const g of grammar) this.grammarById.set(g.id, g);
    this.maxWordLen = maxLen;
  }

  /** Every Word entry (any sense) whose headword or a variant equals `text` exactly. */
  lookup(text: string): Word[] {
    return this.wordsByHeadword.get(text) ?? [];
  }

  byId(id: string): Word | undefined {
    return this.wordsById.get(id);
  }

  grammarItemById(id: string): GrammarItem | undefined {
    return this.grammarById.get(id);
  }

  get maxHeadwordLength(): number {
    return this.maxWordLen;
  }

  /**
   * All Word entries whose headword/variant is exactly `text.slice(pos, pos + len)`
   * for some len >= 1, i.e. every lexicon match that is a valid prefix of
   * `text` starting at `pos`. Used by the segmenter's maximum-matching search.
   * Returned longest-match-first.
   */
  prefixesOf(text: string, pos: number): { len: number; words: Word[] }[] {
    const chars = [...text.slice(pos)];
    const out: { len: number; words: Word[] }[] = [];
    const maxLen = Math.min(this.maxWordLen, chars.length);
    for (let len = maxLen; len >= 1; len--) {
      const span = chars.slice(0, len).join('');
      const words = this.wordsByHeadword.get(span);
      if (words && words.length > 0) out.push({ len, words });
    }
    return out;
  }

  /** Single-character lexicon info, if this exact character is itself an entry. */
  charInfo(ch: string): { words: Word[]; level: Level | null } {
    const words = this.wordsByHeadword.get(ch) ?? [];
    const level = words.find((w) => w.level)?.level ?? null;
    return { words, level };
  }

  get size(): number {
    return this.wordsById.size;
  }

  /** Every Word in the lexicon, one entry per sense (not deduped by headword). */
  allWords(): Word[] {
    return [...this.wordsById.values()];
  }
}
