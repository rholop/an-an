// Phase 48 Part B.6: fair grammar choices. The wrong markers of a fill-the-pattern exercise come
// from the markers that compete in the same slot first (跟 / 和 / 在 / 給 for 跟…一起, 還 / 才 /
// 就 / 都 for 還沒), then other markers of a similar length, and the set never makes the answer
// the odd one out (`oddOneOut` on the text). Pure.

import { oddOneOut } from './fair.js';

/** Markers that can stand in the same place in a sentence. Hand-made; a marker may be in several. */
export const GRAMMAR_SLOTS: ReadonlyArray<readonly string[]> = [
  ['跟', '和', '在', '給', '對', '向', '替', '幫'], // co-verbs before the verb
  ['還', '才', '就', '都', '也', '又', '再', '已經', '只'], // adverbs before the verb
  ['了', '過', '著'], // aspect after the verb
  ['的', '得', '地'],
  ['嗎', '呢', '吧', '啊'], // sentence-final particles
  ['會', '能', '可以', '要', '想', '應該', '得'], // modals
  ['不', '沒', '沒有', '別', '不要'], // negation
  ['比', '跟', '像', '沒有'], // comparison
  ['很', '太', '真', '非常', '最', '更', '比較', '有點', '有一點', '好'], // degree
  ['把', '被', '讓', '叫', '給'], // disposal, passive, causative
  ['從', '到', '往', '離', '在'], // place and direction
  ['因為', '所以', '但是', '可是', '如果', '雖然', '還是', '或是', '而且', '然後'], // connectors
  ['什麼', '哪', '誰', '幾', '多少', '怎麼', '為什麼', '哪裡', '怎麼樣'], // question words
  ['這', '那', '哪', '這個', '那個', '哪個'],
  ['是', '有', '在'],
  ['正在', '在', '正'],
  ['個', '本', '張', '杯', '隻', '件', '條', '位', '次'], // measure words
  ['一起', '一樣', '一點', '一下'],
];

/** Markers that share a slot with `answer` (not itself). */
export function sameSlotMarkers(answer: string): Set<string> {
  const out = new Set<string>();
  for (const slot of GRAMMAR_SLOTS) if (slot.includes(answer)) for (const m of slot) if (m !== answer) out.add(m);
  return out;
}

/**
 * Up to `n` wrong markers for `answer` from `pool`: same-slot markers first, then by length, a
 * seeded shuffle inside each; a marker that would make the answer the odd one out is skipped.
 * `shuffle` is the caller's seeded shuffle.
 */
export function fairGrammarDistractors(
  answer: string,
  pool: readonly string[],
  n: number,
  shuffle: <T>(a: readonly T[]) => T[],
): string[] {
  const slot = sameSlotMarkers(answer);
  const len = [...answer].length;
  const ranked = shuffle([...new Set(pool)].filter((w) => w !== answer)).sort(
    (a, b) =>
      Number(slot.has(b)) - Number(slot.has(a)) || Math.abs([...a].length - len) - Math.abs([...b].length - len),
  );
  const out: string[] = [];
  for (const w of ranked) {
    if (out.length >= n) break;
    if (!oddOneOut(answer, [...out, w])) out.push(w);
  }
  return out;
}
