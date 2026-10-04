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

/** The lesson-scoped validator behind "scenario replies meet the validator with the lesson-scoped vocabulary". */
export function makeScopeChecker(lexicon: Lexicon, book: Textbook, n: number): ScopeChecker {
  const scoped = lessonScopedWordIds(book, n);
  const readable = new Set([...scoped, ...derivedCompoundIds(lexicon, scoped)]);
  const forms = new Set<string>();
  for (const id of readable) {
    const w = lexicon.byId(id);
    if (w) for (const f of [w.headword, ...w.variants]) forms.add(f);
  }
  const maxLen = Math.max(1, ...[...forms].map((f) => [...f].length));
  const hints = (zh: string): HintToken[] => {
    const chars = [...zh];
    const out: HintToken[] = [];
    let pos = 0;
    let offset = 0;
    while (pos < chars.length) {
      let hit = 0;
      for (let len = Math.min(maxLen, chars.length - pos); len >= 1; len--) {
        if (forms.has(chars.slice(pos, pos + len).join(''))) {
          hit = len;
          break;
        }
      }
      const take = hit || 1;
      const text = chars.slice(pos, pos + take).join('');
      if (hit) out.push({ start: offset, end: offset + text.length });
      offset += text.length;
      pos += take;
    }
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
