import {
  capMixedCards,
  emptyCard,
  lessonTaughtItems,
  pickNewForSession,
  describeSkillCard,
  orderSession,
  studyRank,
  type ItemRef,
  type Lesson,
  type NewAllowance,
  type OrderedSession,
  type SkillCard,
  type StudyFocus,
} from '@anan/core';

/** A card for an item that has no card yet (shown as New): rating it records the first evidence. */
export function newSessionCard(item: ItemRef, now: Date): SkillCard {
  return {
    item,
    skill: 'recognition',
    card: emptyCard(now),
    state: 'unseen',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}

/**
 * Phase 19: the review screen's session builder (normal review, Phase 14 study order, garden and
 * "Study this lesson" vocab). The caller picks the cards; this only orders them, through the one
 * shared `orderSession`: new items first, then due cards textbook-first (study order on), each
 * band a seeded shuffle with siblings kept apart.
 */
export function buildReviewSession(input: {
  due: readonly SkillCard[];
  /** Brand-new items' first cards (recognition), introduced this session. */
  fresh?: readonly SkillCard[];
  focus?: StudyFocus;
  lessonIdx?: ReadonlyMap<string, string>;
  seed: string;
  recent?: readonly (readonly string[])[];
}): OrderedSession<SkillCard> {
  const fresh = new Set(input.fresh ?? []);
  const focus = input.focus?.enabled ? input.focus : undefined;
  const idx = input.lessonIdx;
  const rank = (item: ItemRef) =>
    focus && idx ? studyRank(focus, (i) => idx.get(`${i.kind}:${i.id}`), item) : 0;
  // Phase 21: a journal "priority" word (a gap the learner hit while writing) comes right after
  // the new items, in Review as well as Cloze.
  return orderSession(
    [...(input.fresh ?? []), ...input.due],
    (c) => describeSkillCard(c, { band: fresh.has(c) ? 0 : c.flags.priority ? 1 : 2 + rank(c.item) }),
    { seed: input.seed, recent: input.recent },
  );
}

/**
 * Phase 21 Part D: "Study this lesson" vocabulary is a real session: the lesson's Due cards
 * (recognition and production), then its New items (existing New cards first, then words with no
 * card yet) under the same Phase 20 allowance as Review. Never empty while the lesson has words
 * left to learn, unless new words are paused (the caller says why).
 */
export function lessonSessionCards(input: {
  due: readonly SkillCard[];
  newCards: readonly SkillCard[];
  lesson: Pick<Lesson, 'vocab' | 'grammarWords' | 'properNouns' | 'grammar'> & Partial<Pick<Lesson, 'supplementary' | 'extra'>>;
  /** Phase 34: the lesson's extra words join its new words, after the core ones (default on). */
  teachExtras?: boolean;
  focus?: StudyFocus;
  lessonIdx?: ReadonlyMap<string, string>;
  /** Items the learner already has a card for (so they aren't introduced twice). */
  hasCard: (i: ItemRef) => boolean;
  allowedNew: number;
  maxDue?: number;
}): { due: SkillCard[]; fresh: SkillCard[]; newItems: ItemRef[] } {
  const words = lessonTaughtItems(input.lesson, input.teachExtras !== false).filter((i) => i.kind === 'word');
  const keys = new Set(words.map((i) => `${i.kind}:${i.id}`));
  // Phase 23: reading (pinyin) cards aren't part of lesson mastery: they stay in Review and Pinyin & tones.
  const mine = (c: SkillCard) => c.skill !== 'reading' && keys.has(`${c.item.kind}:${c.item.id}`);
  const due = input.due.filter(mine).slice(0, input.maxDue ?? 40);
  const picked = pickNewForSession({
    newCards: input.newCards.filter((c) => c.skill !== 'reading'),
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.lessonIdx ? { lessonIdx: input.lessonIdx } : {}),
    allowed: input.allowedNew,
    onlyItems: keys,
    extraItems: words.filter((i) => !input.hasCard(i)),
  });
  return { due, fresh: picked.cards, newItems: picked.items };
}

/**
 * Phase 20: this session's review cards under the cap (study order first, then the cards most
 * likely forgotten), and how many new items may join (none in a backlog, half when it's building).
 * Phase 23: per review session, mixed ~40/40/20 across meaning, production and reading when the cap
 * bites; new production / reading faces of words already being learned have their own allowance.
 */
export function pickReviewCards(input: {
  due: readonly SkillCard[];
  /** Phase 21: New cards (introduced, never answered), e.g. from My class or a lookup. */
  newCards?: readonly SkillCard[];
  /** Distinct cards answered in Review this session (`reviewStatus().doneThisSession`). */
  doneThisSession: number;
  cap: number;
  focus?: StudyFocus;
  lessonIdx?: ReadonlyMap<string, string>;
  now: Date;
  /** Phase 29 Part B.4: the Review queue's new-word allowance (`ledger.newAllowance('review')`). */
  allowance: Pick<NewAllowance, 'state' | 'allowed' | 'faces' | 'message'>;
  /** Phase 23: words due in the next session too (between sessions): their new faces wait as well. */
  holdFaceWords?: Iterable<string>;
}): {
  due: SkillCard[];
  /** New cards that join this session. */
  fresh: SkillCard[];
  /** Items with no card yet that join this session. */
  newItems: ItemRef[];
  held: number;
  newPaused: boolean;
  newReason?: string;
} {
  const focus = input.focus?.enabled ? input.focus : undefined;
  const idx = input.lessonIdx;
  const rank =
    focus && idx ? (c: SkillCard) => studyRank(focus, (i) => idx.get(`${i.kind}:${i.id}`), c.item) : undefined;
  const remaining = Math.max(0, input.cap - input.doneThisSession);
  const due = capMixedCards(input.due, { remaining, now: input.now, ...(rank ? { rank } : {}) });
  // Phase 29 Part B.4: the one new-word allowance (the ledger's): paused only when more is due now
  // than the whole cap, and "this session's limit" once the cap is used up (not a backlog).
  const allowance = input.allowance;
  const roomForNew = Math.max(0, remaining - due.length);
  // One "new" rule for every session (core `pickNewForSession`): New cards and study-order items
  // together, never more than the allowance (Phase 20) — My class cards are no longer uncapped.
  // Phase 23: a word's new Pick / Say it card waits while the word itself is due this session, so
  // it never pushes the due card out (a word's cards are kept apart, Phase 19).
  const dueWords = new Set([...due.map((c) => `${c.item.kind}:${c.item.id}`), ...(input.holdFaceWords ?? [])]);
  const newCards = (input.newCards ?? []).filter((c) => c.skill === 'recognition' || !dueWords.has(`${c.item.kind}:${c.item.id}`));
  const picked = pickNewForSession({
    newCards,
    ...(focus ? { focus } : {}),
    ...(idx ? { lessonIdx: idx } : {}),
    allowed: Math.min(allowance.allowed, roomForNew),
    // new faces follow the same pause / halving as new words
    allowedFaces: Math.min(allowance.faces, Math.max(0, roomForNew - allowance.allowed)),
  });
  return {
    due,
    fresh: picked.cards,
    newItems: picked.items,
    held: input.due.length - due.length,
    newPaused: allowance.allowed === 0 && allowance.state !== 'open',
    ...(allowance.message ? { newReason: allowance.message } : {}),
  };
}
