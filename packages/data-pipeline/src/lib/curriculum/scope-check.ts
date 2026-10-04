import {
  analyzeText,
  derivedCompoundIds,
  lessonScopedWordIds,
  type AnalyzeResult,
  type HintToken,
  type Lexicon,
  type Textbook,
} from '@anan/core';

export interface ScopeChecker {
  /** Word ids a lesson-n text may use (textbook words ≤ n, names, grammar words, obvious compounds/parts). */
  readable: ReadonlySet<string>;
  /** Hints segmenting `zh` with the in-scope words first (as the chat flow does with the model's tokens). */
  hints(zh: string): HintToken[];
  /** 100% of tokens must be in scope and the text must be Taiwan-clean. */
  check(zh: string): AnalyzeResult;
}

/** The lesson-scoped validator behind "scenario replies meet the validator with the lesson-scoped vocabulary" (course words up to and including the lesson, its proper nouns, obvious compounds). */
export function makeScopeChecker(
  lexicon: Lexicon,
  book: Textbook | readonly Textbook[],
  n: number,
  bookId?: string,
): ScopeChecker {
  // Phase 13: with several books "up to lesson n of bookId" is in COURSE order.
  const scoped = lessonScopedWordIds(book as Textbook | Textbook[], n, bookId ? { bookId } : {});
  const readable = new Set([...scoped, ...derivedCompoundIds(lexicon, scoped)]);
  const formsOf = (ids: Iterable<string>) => {
    const forms = new Set<string>();
    for (const id of ids) {
      const w = lexicon.byId(id);
      if (w) for (const f of [w.headword, ...w.variants]) forms.add(f);
    }
    return forms;
  };
  // Words the course actually teaches take priority over obvious compounds
  // (吃水 = 吃 + 水 must not swallow the 水 of 水果).
  const explicitForms = formsOf(scoped);
  const allForms = formsOf(readable);
  const maxLen = Math.max(1, ...[...allForms].map((f) => [...f].length));
  const hints = (zh: string): HintToken[] => {
    const chars = [...zh];
    const offsets: number[] = [];
    let o = 0;
    for (const c of chars) {
      offsets.push(o);
      o += c.length;
    }
    offsets.push(o);
    const spans = (forms: Set<string>, pos: number, len: number) =>
      forms.has(chars.slice(pos, pos + len).join(''));
    // A compound that is only "readable" (not taught) must not cut across a taught word:
    // 吃水 would swallow the 水 of 水果.
    const crossesTaught = (pos: number, len: number): boolean => {
      for (let k = pos + 1; k < pos + len; k++)
        for (let l = 2; l <= maxLen && k + l <= chars.length; l++)
          if (k + l > pos + len && spans(explicitForms, k, l)) return true;
      return false;
    };
    const taken = new Array<number>(chars.length).fill(0); // token length starting here
    for (let pos = 0; pos < chars.length; ) {
      let hit = 0;
      for (let len = Math.min(maxLen, chars.length - pos); len >= 1; len--) {
        if (!spans(allForms, pos, len)) continue;
        if (!spans(explicitForms, pos, len) && crossesTaught(pos, len)) continue;
        hit = len;
        break;
      }
      if (hit) {
        taken[pos] = hit;
        pos += hit;
      } else pos++;
    }
    const out: HintToken[] = [];
    for (let pos = 0; pos < chars.length; pos += taken[pos] || 1)
      if (taken[pos]) out.push({ start: offsets[pos]!, end: offsets[pos + taken[pos]!]! });
    return out;
  };
  const ctx = {
    lexicon,
    learnerLevel: 'N1' as const,
    knownIds: readable,
    dueIds: new Set<string>(),
    targetIds: new Set<string>(),
    learningIds: new Set<string>(),
    allowedExtraIds: new Set<string>(),
  };
  return {
    readable,
    hints,
    check: (zh) => analyzeText(zh, ctx, hints(zh), { coverageThreshold: 1, maxUnknownTokens: 0 }),
  };
}
