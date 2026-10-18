// Phase 46 Parts C.2 and D.5: classes saved before Phase 46, fixed once. Their grammar names, notes
// and examples lose any simplified character (OpenCC, never AI), and their matches are re-checked
// with the stricter rules. A match the owner set on the class page is never changed; answers already
// recorded stay on the item they were given for (evidence is never touched here).
import type { Lexicon } from '../lexicon.js';
import { replaceSimplifiedChars } from '../taiwanness.js';
import { matchTutorGrammar } from './draft.js';
import type { TutorGrammarChange, TutorSessionGrammar, TutorSessionRecord } from './session.js';

export interface TutorTextConverters {
  /** OpenCC cn → tw (characters only): says whether a character is simplified. */
  toTraditional: (s: string) => string;
  /** OpenCC cn → twp (Taiwan phrases). */
  toTaiwan: (s: string) => string;
}

const HAN_RUN = /\p{Script=Han}+/gu;

/**
 * Chinese runs with a simplified character are converted (cn → twp, then the character table);
 * runs already traditional and all English are left exactly as they are.
 */
export function toTaiwanRuns(text: string, conv: TutorTextConverters): string {
  return text.replace(HAN_RUN, (run) =>
    [...run].some((c) => conv.toTraditional(c) !== c) ? replaceSimplifiedChars(conv.toTaiwan(run)) : replaceSimplifiedChars(run),
  );
}

/** The class points of a record: rows that share `point` (a point comparing two items) go together. */
export function tutorGrammarPoints(rows: readonly TutorSessionGrammar[]): TutorSessionGrammar[][] {
  const groups = new Map<string, TutorSessionGrammar[]>();
  rows.forEach((g, i) => {
    const key = g.point ?? `row${i}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  });
  return [...groups.values()];
}

/**
 * Converts a record's grammar text and re-matches its points. Returns the new rows and the points
 * whose match changed (by pattern; [] = a note).
 */
export function recheckTutorGrammar(
  rec: Pick<TutorSessionRecord, 'grammar'>,
  lexicon: Pick<Lexicon, 'grammarItemById'>,
  conv: TutorTextConverters,
): { grammar: TutorSessionGrammar[]; changes: TutorGrammarChange[] } {
  const pattern = (id: string | undefined) => (id ? (lexicon.grammarItemById(id)?.pattern ?? id) : undefined);
  const changes: TutorGrammarChange[] = [];
  const grammar: TutorSessionGrammar[] = [];
  tutorGrammarPoints(rec.grammar).forEach((rows, k) => {
    const first = rows[0]!;
    const base = {
      name: toTaiwanRuns(first.name, conv),
      explanationEn: toTaiwanRuns(first.explanationEn, conv),
      example: { zh: toTaiwanRuns(first.example.zh, conv), en: first.example.en },
      point: first.point ?? `p${k}`,
    };
    if (rows.some((r) => r.matchedBy === 'owner')) {
      grammar.push(...rows.map((r) => ({ ...r, ...base })));
      return;
    }
    const ids = matchTutorGrammar(base.name, base.example.zh, lexicon).map((g) => g.id);
    const before = rows.flatMap((r) => (r.grammarId ? [r.grammarId] : []));
    if ([...before].sort().join('|') !== [...ids].sort().join('|'))
      changes.push({ name: base.name, from: before.map((id) => pattern(id)!), to: ids.map((id) => pattern(id)!) });
    grammar.push(...(ids.length > 0 ? ids.map((grammarId) => ({ ...base, grammarId })) : [base]));
  });
  return { grammar, changes };
}

/**
 * Part D.4: the owner's "Matched to … · Change" for one class point (`point`, or the row's index for
 * rows saved before points existed): one item, or null = "Make this a note".
 */
export function setTutorGrammarMatch(
  rows: readonly TutorSessionGrammar[],
  rowIndex: number,
  grammarId: string | null,
): TutorSessionGrammar[] {
  const row = rows[rowIndex];
  if (!row) return [...rows];
  const point = row.point;
  const inPoint = (r: TutorSessionGrammar, i: number) => (point ? r.point === point : i === rowIndex);
  const { grammarId: _old, ...rest } = row;
  const next: TutorSessionGrammar = { ...rest, matchedBy: 'owner', ...(grammarId ? { grammarId } : {}) };
  const out: TutorSessionGrammar[] = [];
  let placed = false;
  rows.forEach((r, i) => {
    if (!inPoint(r, i)) out.push(r);
    else if (!placed) {
      out.push(next);
      placed = true;
    }
  });
  return out;
}
