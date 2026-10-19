import { describe, expect, it } from 'vitest';
import { seededRng } from '../session/orderSession.js';
import { fairGrammarDistractors, oddOneOut, sameSlotMarkers } from './index.js';

// Phase 48 Part B.6: grammar choices prefer markers that compete in the same slot.
const shuffleWith = (seed: string) => {
  const rng = seededRng(seed);
  return <T>(a: readonly T[]): T[] => {
    const c = [...a];
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [c[i], c[j]] = [c[j]!, c[i]!];
    }
    return c;
  };
};
const POOL = ['和', '在', '給', '嗎', '很', '了', '的', '才', '就', '都', '比', '把', '不', '會', '一起', '因為'];

describe('fair grammar choices (Phase 48)', () => {
  it.each(['a', 'b', 'c', 'd'])('跟 (跟…一起): 和 / 在 / 給 compete in its slot (seed %s)', (seed) => {
    const d = fairGrammarDistractors('跟', POOL, 3, shuffleWith(seed));
    expect(d).toHaveLength(3);
    for (const x of d) expect(sameSlotMarkers('跟').has(x)).toBe(true);
  });

  it.each(['a', 'b', 'c'])('還 (還沒): 才 / 就 / 都 first (seed %s)', (seed) => {
    const d = fairGrammarDistractors('還', POOL, 3, shuffleWith(seed));
    expect(d.every((x) => ['才', '就', '都', '在', '和', '給'].includes(x) || sameSlotMarkers('還').has(x))).toBe(true);
    expect(d.filter((x) => ['才', '就', '都'].includes(x)).length).toBe(3);
  });

  it('never makes the answer the odd one out (一起 against 一下 / 一點 / 一樣 is fine, against 因為 / 因此 it is not)', () => {
    expect(oddOneOut('一起', ['一起', '一下', '一點'])).toBe(false);
    expect(oddOneOut('所以', ['所以', '因為', '因此'])).toBe(true);
    for (const seed of ['a', 'b', 'c']) {
      const d = fairGrammarDistractors('所以', ['因為', '因此', '但是', '如果'], 3, shuffleWith(seed));
      expect(oddOneOut('所以', ['所以', ...d])).toBe(false);
      expect(d.filter((x) => x.startsWith('因')).length).toBeLessThan(2);
    }
  });
});
