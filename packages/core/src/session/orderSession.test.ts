import { describe, expect, it } from 'vitest';
import {
  isOrderedSession,
  orderSession,
  placeExtras,
  requeueAgain,
  seededRng,
  sessionMeta,
  type CardDirection,
  type SessionCard,
} from './orderSession.js';

interface C {
  id: string;
  word: string;
  kind: 'recognition' | 'production' | 'cloze' | 'listening';
  isNew?: boolean;
  band?: number;
}

const describeC = (c: C): SessionCard => ({
  keys: [`word:${c.word}`],
  ...(c.kind === 'recognition'
    ? { direction: 'zh-en' as CardDirection }
    : c.kind === 'production'
      ? { direction: 'en-zh' as CardDirection }
      : {}),
  ...(c.isNew ? { isNew: true } : {}),
  ...(c.band !== undefined ? { band: c.band } : {}),
});

/** A random session: sizes 5–60, words with 1–4 cards each, mixes of new, due, cloze and listening. */
function randomSession(rng: () => number): C[] {
  const size = 5 + Math.floor(rng() * 56);
  const out: C[] = [];
  let w = 0;
  while (out.length < size) {
    const word = `w${w++}`;
    const isNew = rng() < 0.25;
    const band = Math.floor(rng() * 3);
    const kinds: C['kind'][] = ['recognition'];
    if (rng() < 0.7) kinds.push('production');
    if (rng() < 0.3) kinds.push('cloze');
    if (rng() < 0.2) kinds.push('listening');
    for (const kind of kinds) if (out.length < size) out.push({ id: `${word}-${kind}`, word, kind, isNew, band });
  }
  return out;
}

function checkGap(order: C[], gap = 5) {
  const last = new Map<string, number>();
  order.forEach((c, i) => {
    const prev = last.get(c.word);
    if (prev !== undefined) expect(i - prev, `${c.word} at ${prev} and ${i}`).toBeGreaterThan(gap);
    last.set(c.word, i);
  });
}

/** Longest same-direction run while the rest of the session still has the other direction. */
function worstRunWhileBothPresent(order: C[]): number {
  const dir = (c: C) => describeC(c).direction;
  let worst = 0;
  let run = 0;
  let prev: CardDirection | undefined;
  order.forEach((c, i) => {
    const d = dir(c);
    run = d && d === prev ? run + 1 : d ? 1 : 0;
    prev = d;
    const other = d === 'zh-en' ? 'en-zh' : 'zh-en';
    if (d && order.slice(i + 1).some((x) => dir(x) === other)) worst = Math.max(worst, run);
  });
  return worst;
}

describe('orderSession', () => {
  it('property: 1,000 random sessions keep siblings 5+ apart and direction runs ≤ 3', () => {
    const rng = seededRng('property');
    let runViolations = 0;
    for (let s = 0; s < 1000; s++) {
      const cards = randomSession(rng);
      const ordered = orderSession(cards, describeC, { seed: `s${s}` });
      checkGap(ordered);
      // Nothing lost: every card is either shown or deferred.
      expect(ordered.length + sessionMeta(ordered)!.deferred.length).toBe(cards.length);
      if (worstRunWhileBothPresent(ordered) > 3) runViolations++;
    }
    expect(runViolations).toBe(0);
  });

  it('never shows a new word’s production card before its recognition card', () => {
    const rng = seededRng('new-words');
    for (let s = 0; s < 300; s++) {
      const cards = randomSession(rng);
      const ordered = orderSession(cards, describeC, { seed: `n${s}` });
      const seenRecog = new Set<string>();
      for (const c of ordered) {
        if (c.kind === 'recognition') seenRecog.add(c.word);
        if (c.kind === 'production' && c.isNew) expect(seenRecog.has(c.word)).toBe(true);
      }
    }
  });

  it('an unreviewed production card whose recognition card is not in the session (met earlier) is shown', () => {
    const cards: C[] = [
      { id: 'a', word: 'a', kind: 'production', isNew: true },
      { id: 'b', word: 'b', kind: 'recognition' },
    ];
    const ordered = orderSession(cards, describeC, { seed: 'x' });
    expect(new Set(ordered.map((c) => c.id))).toEqual(new Set(['a', 'b']));
  });

  it('a lesson of 10 new words, recognition only, is shown out of book order', () => {
    const cards: C[] = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, word: `w${i}`, kind: 'recognition', isNew: true }));
    const ordered = orderSession(cards, describeC, { seed: 'lesson-1' });
    expect(ordered).toHaveLength(10);
    expect(ordered.every((c) => c.kind === 'recognition')).toBe(true);
    expect(ordered.map((c) => c.id)).not.toEqual(cards.map((c) => c.id));
  });

  it('defers a sibling when the session is too short for the gap', () => {
    const cards: C[] = [
      { id: 'a-r', word: 'a', kind: 'recognition' },
      { id: 'a-p', word: 'a', kind: 'production' },
      { id: 'b-r', word: 'b', kind: 'recognition' },
    ];
    const ordered = orderSession(cards, describeC, { seed: 'short' });
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((c) => c.word))).toEqual(new Set(['a', 'b']));
    expect(sessionMeta(ordered)!.deferred).toHaveLength(1);
  });

  it('keeps the builder’s bands: lower bands come first when nothing forces otherwise', () => {
    const cards: C[] = Array.from({ length: 20 }, (_, i) => ({
      id: `w${i}`,
      word: `w${i}`,
      kind: 'cloze',
      band: i < 10 ? 1 : 0,
    }));
    const ordered = orderSession(cards, describeC, { seed: 'bands' });
    expect(ordered.slice(0, 10).every((c) => c.band === 0)).toBe(true);
  });

  it('same seed → same order; different seed → different order', () => {
    const cards = randomSession(seededRng('fixed'));
    const a = orderSession(cards, describeC, { seed: 'one' }).map((c) => c.id);
    const b = orderSession(cards, describeC, { seed: 'one' }).map((c) => c.id);
    const c = orderSession(cards, describeC, { seed: 'two' }).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('applies the gap across a boundary with the previous part (recent)', () => {
    const cards: C[] = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, word: `w${i}`, kind: 'cloze' }));
    for (let s = 0; s < 50; s++) {
      const ordered = orderSession(cards, describeC, { seed: `r${s}`, recent: [['word:w0'], ['word:w1']] });
      const i0 = ordered.findIndex((c) => c.word === 'w0');
      const i1 = ordered.findIndex((c) => c.word === 'w1');
      // w1 was shown last, w0 one before it: both need 5 other cards in between.
      expect(i1).toBeGreaterThanOrEqual(5);
      expect(i0).toBeGreaterThanOrEqual(4);
    }
  });

  it('marks its result so a builder that skipped it can be caught', () => {
    const cards: C[] = [{ id: 'a', word: 'a', kind: 'cloze' }];
    expect(isOrderedSession(orderSession(cards, describeC, { seed: 'm' }))).toBe(true);
    expect(isOrderedSession(cards)).toBe(false);
  });
});

describe('requeueAgain', () => {
  const q = (words: string[]): C[] => words.map((w, i) => ({ id: `${w}-${i}`, word: w, kind: 'cloze' }));

  it('puts an Again card at least 5 cards later', () => {
    const queue = q(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    const next = requeueAgain(queue, 0, describeC);
    expect(next).toHaveLength(10);
    const again = next.findIndex((c, i) => i > 0 && c.word === 'a');
    expect(again).toBeGreaterThanOrEqual(6);
  });

  it('never next to (or within the gap of) a sibling', () => {
    const queue = q(['a', 'b', 'c', 'd', 'e', 'f', 'a', 'g', 'h', 'i', 'j', 'k', 'l', 'm']);
    const next = requeueAgain(queue, 0, describeC);
    checkGap(next);
  });

  it('leaves the queue alone when there is no room', () => {
    const queue = q(['a', 'b', 'c']);
    expect(requeueAgain(queue, 0, describeC)).toEqual(queue);
  });
});

describe('placeExtras', () => {
  it('keeps an extra exercise 5+ away from cards on the same word', () => {
    const queue: C[] = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, word: `w${i % 10}`, kind: 'recognition' }));
    const extras: C[] = [
      { id: 'l1', word: 'w3', kind: 'listening' },
      { id: 'l2', word: 'w7', kind: 'listening' },
      { id: 'l3', word: 'zz', kind: 'listening' },
    ];
    const slots = placeExtras(queue, extras, describeC, describeC);
    expect(slots.size).toBeGreaterThan(0);
    for (const [p, e] of slots) {
      for (let j = p - 5; j < p + 5; j++) if (queue[j]) expect(queue[j]!.word).not.toBe(e.word);
    }
  });
});
