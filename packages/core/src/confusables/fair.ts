// Phase 48 Part B: what makes a set of options fair. Every wrong option must be close to the
// answer on at least one axis (`axesBetween`), and the answer must never be the odd one out
// (`oddOneOut`): the wrong options may not share a character, prefix, suffix or meaning category
// that the answer lacks (廚師 / 醫師 / 老師 against 平常, 星期四 / 星期五 / 星期日 against 冰淇淋).
// Pure.

import type { Word } from '../types.js';
import { meaningCategories, samePosFamily, type MeaningCategory } from './categories.js';

export type DistractorAxis = 'char' | 'shape' | 'sound' | 'meaning' | 'confused';
export const DISTRACTOR_AXES: readonly DistractorAxis[] = ['char', 'shape', 'sound', 'meaning', 'confused'];

type WordLike = Pick<Word, 'headword' | 'pinyinNumeric' | 'pos' | 'glossEn' | 'senses' | 'primarySenseId' | 'textbookSenseId' | 'tags'>;

const tonelessSyllables = (w: Pick<Word, 'pinyinNumeric'>): string[] =>
  w.pinyinNumeric.trim().toLowerCase().split(/\s+/).filter(Boolean).map((s) => s.replace(/[0-5]$/, ''));

/**
 * The axes on which `other` is close to `target`:
 * - `char`: a character in common, in the same or the next position (平常 → 平安, 常常, 非常);
 * - `shape`: a look-alike character in the same position (`similar`, Unihan shape and hand pairs),
 *   and in a longer word more than half of it the same or alike (冰淇淋 / 冰淇林, not 平常 / 老師);
 * - `sound`: the same syllables in any tone or a near sound (zh/z, ch/c, sh/s, -n/-ng), or (2+
 *   syllables) at least half of them the same in the same place (老師 / 老實);
 * - `meaning`: the same part of speech and a meaning category in common (冰淇淋 → 巧克力).
 */
export function axesBetween(
  target: WordLike,
  other: WordLike,
  similar: (a: string, b: string) => number,
): Set<DistractorAxis> {
  const out = new Set<DistractorAxis>();
  const a = [...target.headword];
  const b = [...other.headword];
  if (a.some((ch, i) => b[i] === ch || b[i - 1] === ch || b[i + 1] === ch)) out.add('char');
  const alike = a.filter((ch, i) => b[i] !== undefined && b[i] !== ch && similar(ch, b[i]!) > 0).length;
  const same = a.filter((ch, i) => b[i] === ch).length;
  if (alike > 0 && (alike + same) * 2 > a.length) out.add('shape');
  const sa = tonelessSyllables(target);
  const sb = tonelessSyllables(other);
  const near = (x: string[]) => x.map(nearSyllable).join(' ');
  if (sa.length > 0 && sa.length === sb.length && near(sa) === near(sb)) out.add('sound');
  else if (sa.length >= 2 && sa.filter((s, i) => sb[i] === s).length * 2 >= sa.length) out.add('sound');
  if (sharedCategory(target, other) && samePosFamily(target, other)) out.add('meaning');
  return out;
}

/** A syllable with the sounds learners mix up folded together: zh/z, ch/c, sh/s, -ng/-n. */
export function nearSyllable(s: string): string {
  return s.replace(/^([zcs])h/, '$1').replace(/ng$/, 'n');
}

function sharedCategory(a: WordLike, b: WordLike): boolean {
  const cb = meaningCategories(b);
  return [...meaningCategories(a)].some((c) => cb.has(c));
}

const text = (x: string | Pick<Word, 'headword'>) => (typeof x === 'string' ? x : x.headword);

/** What the wrong options all share and the answer lacks (undefined when nothing): for tests,
 * the audit report and the picker's swap. */
export function oddOneOutReason(
  answer: string | WordLike,
  options: ReadonlyArray<string | WordLike>,
): string | undefined {
  const ans = text(answer);
  const wrong = options.filter((o) => text(o) !== ans);
  if (wrong.length < 2) return undefined;
  const ac = [...ans];
  const wc = wrong.map((o) => [...text(o)]);
  // a character in the same position, counted from the start and from the end (星期*, *師)
  for (const fromEnd of [false, true]) {
    const at = (cs: string[], i: number) => (fromEnd ? cs[cs.length - 1 - i] : cs[i]);
    const first = wc[0]!;
    for (let i = 0; i < first.length; i++) {
      const ch = at(first, i)!;
      if (wc.every((cs) => at(cs, i) === ch) && at(ac, i) !== ch)
        return `the wrong options all have ${ch} ${fromEnd ? (i === 0 ? 'at the end' : `${i + 1} from the end`) : i === 0 ? 'first' : `in place ${i + 1}`}`;
    }
  }
  // all the same meaning category, and the answer has another one (or none)
  if (typeof answer !== 'string' && wrong.every((o) => typeof o !== 'string')) {
    const ansCats = meaningCategories(answer);
    let shared: Set<MeaningCategory> | undefined;
    for (const o of wrong as WordLike[]) {
      const c = meaningCategories(o);
      shared = shared ? new Set([...shared].filter((x) => c.has(x))) : new Set(c);
    }
    const lacking = [...(shared ?? [])].filter((c) => !ansCats.has(c));
    if (lacking.length > 0) return `the wrong options are all ${lacking[0]} words`;
  }
  return undefined;
}

/**
 * True when the answer is the odd one out: the wrong options share something the answer lacks (a
 * character in the same position, a common prefix or suffix, or all one meaning category while the
 * answer has another). `options` may include the answer; it is ignored there.
 */
export function oddOneOut(answer: string | WordLike, options: ReadonlyArray<string | WordLike>): boolean {
  return oddOneOutReason(answer, options) !== undefined;
}
