// Phase 48 Part A: the offline candidate table (`data/build/distractors.v1.json`, built by
// `pnpm build:distractors`, shipped hashed as `lexicon/distractors.v1.json`). For every word that
// can be studied, up to 8 candidates with the axes they are close on; `suggest` marks a checked
// Gemini suggestion (counted as `meaning`). The app adds the same code axes live for words the
// table doesn't have (tutoring and custom words) and the learner's own mix-ups. Pure types.

export type TableAxis = 'char' | 'shape' | 'sound' | 'meaning' | 'suggest';

export interface DistractorTable {
  version: 1;
  /** Word id → [candidate id, axes joined by "+"] (best first). */
  words: Record<string, Array<[string, string]>>;
}

/** Candidates kept per word in the table. */
export const DISTRACTOR_TABLE_SIZE = 8;

export function tableAxes(axes: string): TableAxis[] {
  return axes.split('+').filter((a): a is TableAxis => ['char', 'shape', 'sound', 'meaning', 'suggest'].includes(a));
}
