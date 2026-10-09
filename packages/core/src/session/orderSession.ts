// Phase 19: one ordering function for every flashcard-style session. Builders decide WHICH
// cards go in (priority, study order, due cards); this decides only the ORDER: siblings (cards
// testing the same item) far apart, a seeded shuffle inside each priority band, and both
// directions mixed. Pure: the seed is passed in, nothing reads Math.random or the clock.
import { hashText } from '../hash.js';
import type { ItemRef, Skill } from '../types.js';

/** 'zh-en' = Mandarin shown, meaning asked (recognition); 'en-zh' = the reverse (production). */
export type CardDirection = 'zh-en' | 'en-zh';

/** What `orderSession` needs to know about one card. */
export interface SessionCard {
  /** Sibling keys: two cards are siblings when they share any key (e.g. `word:id`, `zh:捷運`). */
  keys: readonly string[];
  /** Absent for cards with no direction (cloze, listening, grammar, reorder…). */
  direction?: CardDirection;
  /** Priority band from the builder; lower comes first overall. Default 0. */
  band?: number;
  /** First time this item is shown: its production card may only follow its recognition card. */
  isNew?: boolean;
}

export interface OrderSessionOptions {
  /** Seed for the shuffle (the session id). Same seed → same order. */
  seed: string;
  /** Cards between two siblings, at least. Default 5. */
  minSiblingGap?: number;
  /** Same-direction cards in a row, at most (when the rest of the session still has both). Default 3. */
  maxSameDirectionRun?: number;
  /** Keys of the cards shown just before this session (oldest first), e.g. the end of the previous
   * part of "Study this lesson": the gap applies across the boundary. */
  recent?: readonly (readonly string[])[];
}

export const SESSION_ORDER_DEFAULTS = { minSiblingGap: 5, maxSameDirectionRun: 3 } as const;

/** Marker on every result of `orderSession`, so tests can check a builder used it. */
export const ORDERED_SESSION = Symbol.for('anan.orderedSession');

export interface OrderMeta<T> {
  seed: string;
  /** Siblings that did not fit this session without breaking the gap: they wait for the next one. */
  deferred: T[];
}

export type OrderedSession<T> = T[] & { readonly [ORDERED_SESSION]: OrderMeta<T> };

export function isOrderedSession<T>(cards: readonly T[]): cards is OrderedSession<T> {
  return Boolean((cards as Partial<OrderedSession<T>>)[ORDERED_SESSION]);
}

export function sessionMeta<T>(cards: readonly T[]): OrderMeta<T> | undefined {
  return (cards as Partial<OrderedSession<T>>)[ORDERED_SESSION];
}

function mark<T>(cards: T[], meta: OrderMeta<T>): OrderedSession<T> {
  Object.defineProperty(cards, ORDERED_SESSION, { value: meta, enumerable: false });
  return cards as OrderedSession<T>;
}

/** Deterministic PRNG (mulberry32) from a string seed. */
export function seededRng(seed: string): () => number {
  let a = parseInt(hashText(seed), 36) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** A fresh session id to seed with (the only impure helper; call it in the app, not in core logic). */
export function newSessionSeed(prefix = 'session'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function itemKey(item: ItemRef): string {
  return `${item.kind}:${item.id}`;
}

export function skillDirection(skill: Skill): CardDirection | undefined {
  return skill === 'recognition' ? 'zh-en' : skill === 'production' ? 'en-zh' : undefined;
}

/** The usual description of a SkillCard-like card: keyed by its item, direction from its skill,
 * new when it has never been reviewed (so a new word's production card waits for its recognition). */
export function describeSkillCard(
  c: { item: ItemRef; skill: Skill; card?: { reps: number } },
  extra: Partial<SessionCard> = {},
): SessionCard {
  const direction = skillDirection(c.skill);
  return {
    keys: [itemKey(c.item)],
    ...(direction ? { direction } : {}),
    isNew: c.card ? c.card.reps === 0 : false,
    ...extra,
  };
}

const shares = (a: readonly string[], b: readonly string[]) => a.some((k) => b.includes(k));

/**
 * Order a session. Greedy: walk the cards in (band, seeded shuffle) order and take the first one
 * that keeps every rule; a sibling that cannot be placed without breaking the gap is deferred to
 * the next session (like Anki's "bury siblings"). The direction rule gives way only when every
 * remaining card that fits the gap faces the same way.
 */
export function orderSession<T>(
  cards: readonly T[],
  describe: (card: T) => SessionCard,
  opts: OrderSessionOptions,
): OrderedSession<T> {
  const maxRun = opts.maxSameDirectionRun ?? SESSION_ORDER_DEFAULTS.maxSameDirectionRun;
  const described = cards.map((card) => ({ card, d: describe(card) }));
  // The greedy pass can paint itself into a corner near the end (the only cards left are one
  // direction's siblings, still inside the gap). Retry with derived seeds and keep the best:
  // fewest over-long direction runs, then fewest deferred cards. Deterministic for a given seed.
  let best: Attempt<T> | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = greedyOrder(described, attempt === 0 ? opts.seed : `${opts.seed}#${attempt}`, opts);
    const score = [directionViolations(r.out, maxRun), r.deferred.length] as const;
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1]))
      best = { ...r, score };
    if (score[0] === 0 && score[1] === 0) break;
  }
  return mark(
    best!.out.map((x) => x.card),
    { seed: opts.seed, deferred: best!.deferred },
  );
}

const ATTEMPTS = 24;

interface Described<T> {
  card: T;
  d: SessionCard;
}
interface Attempt<T> {
  out: Described<T>[];
  deferred: T[];
  score: readonly [number, number];
}

/** Runs longer than `maxRun` while the rest of the session still has the other direction. */
function directionViolations<T>(out: readonly Described<T>[], maxRun: number): number {
  let n = 0;
  let run = 0;
  let prev: CardDirection | undefined;
  const remaining = { 'zh-en': 0, 'en-zh': 0 };
  for (const x of out) if (x.d.direction) remaining[x.d.direction]++;
  for (const x of out) {
    const dir = x.d.direction;
    run = dir && dir === prev ? run + 1 : dir ? 1 : 0;
    prev = dir;
    if (!dir) continue;
    remaining[dir]--;
    if (run > maxRun && remaining[dir === 'zh-en' ? 'en-zh' : 'zh-en'] > 0) n++;
  }
  return n;
}

function greedyOrder<T>(
  all: readonly Described<T>[],
  seed: string,
  opts: OrderSessionOptions,
): { out: Described<T>[]; deferred: T[] } {
  const gap = opts.minSiblingGap ?? SESSION_ORDER_DEFAULTS.minSiblingGap;
  const maxRun = opts.maxSameDirectionRun ?? SESSION_ORDER_DEFAULTS.maxSameDirectionRun;
  const rng = seededRng(seed);
  const deferred: T[] = [];
  // Rule 3: a new item's production card comes after its recognition card. When the recognition
  // card is not in this session the word was met in an earlier one, so the production card is
  // free to go.
  const recognitionKeys = new Set(all.filter((x) => x.d.direction === 'zh-en').flatMap((x) => x.d.keys));
  const recognitionIn = (keys: readonly string[]) => keys.some((k) => recognitionKeys.has(k));

  const bands = [...new Set(all.map((x) => x.d.band ?? 0))].sort((a, b) => a - b);
  const pending = bands.flatMap((b) => seededShuffle(all.filter((x) => (x.d.band ?? 0) === b), rng));

  const history: (readonly string[])[] = [...(opts.recent ?? [])];
  const out: Described<T>[] = [];
  const placedRecognition: (readonly string[])[] = [];

  const gapOk = (d: SessionCard) => !history.slice(-gap).some((keys) => shares(keys, d.keys));
  const orderOk = (d: SessionCard) =>
    !(d.isNew && d.direction === 'en-zh') ||
    !recognitionIn(d.keys) ||
    placedRecognition.some((k) => shares(k, d.keys));
  const runLength = (dir: CardDirection) => {
    let n = 0;
    for (let i = out.length - 1; i >= 0 && out[i]!.d.direction === dir; i--) n++;
    return n;
  };
  const directionOk = (d: SessionCard) => !d.direction || runLength(d.direction) < maxRun;

  while (pending.length > 0) {
    const lastDir = out[out.length - 1]?.d.direction;
    let i = -1;
    // Two in a row already: switch direction early while a card that fits allows it, so the run
    // limit is rarely the only thing left standing between the other direction's blocked siblings.
    if (lastDir && runLength(lastDir) >= Math.max(1, maxRun - 1))
      i = pending.findIndex((x) => gapOk(x.d) && orderOk(x.d) && x.d.direction !== lastDir);
    if (i < 0) i = pending.findIndex((x) => gapOk(x.d) && orderOk(x.d) && directionOk(x.d));
    if (i < 0) i = pending.findIndex((x) => gapOk(x.d) && orderOk(x.d));
    if (i < 0) {
      // Everything left is a sibling of a card shown within the gap: those wait for the next session.
      deferred.push(...pending.map((x) => x.card));
      break;
    }
    const [x] = pending.splice(i, 1);
    out.push(x!);
    history.push(x!.d.keys);
    if (x!.d.direction === 'zh-en') placedRecognition.push(x!.d.keys);
  }
  return { out, deferred };
}

/**
 * Rule 6: put a card answered "Again" back into the queue at least `minSiblingGap` cards after
 * position `at`, never within the gap of one of its siblings. Returns the new queue, or the
 * queue unchanged when no such place exists (FSRS brings the card back soon anyway).
 */
export function requeueAgain<T>(
  queue: readonly T[],
  at: number,
  describe: (card: T) => SessionCard,
  opts: Pick<OrderSessionOptions, 'minSiblingGap'> = {},
): T[] {
  const gap = opts.minSiblingGap ?? SESSION_ORDER_DEFAULTS.minSiblingGap;
  const card = queue[at];
  if (card === undefined) return [...queue];
  const keys = describe(card).keys;
  const sib = (j: number) => j !== at && j >= 0 && j < queue.length && shares(describe(queue[j]!).keys, keys);
  // Inserting at p puts the card between queue[p-1] and queue[p].
  for (let p = at + gap + 1; p <= queue.length; p++) {
    let ok = true;
    for (let j = p - gap; j < p + gap && ok; j++) if (sib(j)) ok = false;
    if (ok) return [...queue.slice(0, p), card, ...queue.slice(p)];
  }
  return [...queue];
}

/**
 * Phase 15 mixes extra exercises (listening) into a running queue by position. Pick positions
 * spread through the session that keep every extra `minSiblingGap` away from its siblings in the
 * queue and from each other; an extra that fits nowhere is left out.
 */
export function placeExtras<T, E>(
  queue: readonly T[],
  extras: readonly E[],
  describeCard: (card: T) => SessionCard,
  describeExtra: (extra: E) => SessionCard,
  opts: Pick<OrderSessionOptions, 'minSiblingGap'> = {},
): Map<number, E> {
  const gap = opts.minSiblingGap ?? SESSION_ORDER_DEFAULTS.minSiblingGap;
  const keys = queue.map((c) => describeCard(c).keys);
  const placed = new Map<number, E>();
  const placedKeys = new Map<number, readonly string[]>();
  extras.forEach((e, k) => {
    const ek = describeExtra(e).keys;
    const target = Math.max(1, Math.round(((k + 1) * queue.length) / (extras.length + 1)));
    // Search outward from the even-spread target.
    for (let off = 0; off <= queue.length; off++) {
      for (const p of off === 0 ? [target] : [target + off, target - off]) {
        if (p < 1 || p > queue.length || placed.has(p)) continue;
        // The extra shows before queue[p]; its neighbours are queue[p-gap .. p+gap-1].
        let ok = true;
        for (let j = p - gap; j < p + gap && ok; j++) if (keys[j] && shares(keys[j]!, ek)) ok = false;
        for (const [q, qk] of placedKeys) if (Math.abs(q - p) <= gap && shares(qk, ek)) ok = false;
        if (ok) {
          placed.set(p, e);
          placedKeys.set(p, ek);
          return;
        }
      }
    }
  });
  return placed;
}

/** Phase 22: a session that must cover every card it was given ("Review all (N)", "Water all (N)"):
 * siblings the gap would defer go at the end instead of waiting for the next session. */
export function keepDeferred<T>(session: readonly T[]): T[] {
  const meta = sessionMeta(session);
  if (!meta || meta.deferred.length === 0) return [...session];
  return mark([...session, ...meta.deferred], { seed: meta.seed, deferred: [] });
}
