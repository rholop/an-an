import {
  emptyCard,
  lessonTaughtItems,
  pickNewForSession,
  describeSkillCard,
  orderInBlocks,
  reviewBlock,
  studyRank,
  type ItemRef,
  type Lesson,
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
 * "Study this lesson" vocab). The caller picks the cards; this only orders them. Phase 43 Part D: in
 * blocks by card type (Meaning, Pick, Say it, Recall, then grammar); inside a block the shared order
 * (new items first, then due cards textbook-first, a seeded shuffle, siblings apart).
 */
export function buildReviewSession(input: {
  due: readonly SkillCard[];
  /** Brand-new items' first cards and new faces, introduced this session. */
  fresh?: readonly SkillCard[];
  focus?: StudyFocus;
  lessonIdx?: ReadonlyMap<string, string>;
  seed: string;
  recent?: readonly (readonly string[])[];
  /** Tutoring words' cards lead their block with the new items (band 0). */
  tutorWordIds?: ReadonlySet<string>;
}): OrderedSession<SkillCard> {
  const fresh = new Set(input.fresh ?? []);
  const tutor = input.tutorWordIds ?? new Set<string>();
  const focus = input.focus?.enabled ? input.focus : undefined;
  const idx = input.lessonIdx;
  const rank = (item: ItemRef) =>
    focus && idx ? studyRank(focus, (i) => idx.get(`${i.kind}:${i.id}`), item) : 0;
  // Phase 21: a journal "priority" word (a gap the learner hit while writing) comes right after
  // the new items, in Review as well as Cloze.
  return orderInBlocks(
    [...(input.fresh ?? []), ...input.due],
    reviewBlock,
    (c) =>
      describeSkillCard(c, {
        band: fresh.has(c) || (c.item.kind === 'word' && tutor.has(c.item.id)) ? 0 : c.flags.priority ? 1 : 2 + rank(c.item),
      }),
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
 * Phase 43: what Review shows for the ledger's session: its answered cards, its new cards (the day's
 * share, already picked by the ledger, tutoring first), a fixed session's new items that had no card
 * yet, and (before the first answer) study-order words with no card yet up to what is left of the
 * session's share (`ledger.pickNew('review')`).
 */
export function reviewSessionCards(input: {
  session: { cards: readonly SkillCard[]; fresh: readonly SkillCard[]; pendingNewKeys: readonly string[] };
  /** Study-order items with no card yet (`ledger.pickNew('review').items`). */
  newItems?: readonly ItemRef[];
  now: Date;
}): { due: SkillCard[]; fresh: SkillCard[] } {
  const fresh = new Set(input.session.fresh);
  const pending = input.session.pendingNewKeys.flatMap((k): ItemRef[] => {
    const m = /^(word|grammar):(.+)\|recognition$/.exec(k);
    return m ? [{ kind: m[1] as ItemRef['kind'], id: m[2]! }] : [];
  });
  const seen = new Set(input.session.cards.map((c) => `${c.item.kind}:${c.item.id}`));
  const extra = [...pending, ...(input.newItems ?? [])].filter((i) => {
    const k = `${i.kind}:${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    due: input.session.cards.filter((c) => !fresh.has(c)),
    fresh: [...input.session.fresh, ...extra.map((i) => newSessionCard(i, input.now))],
  };
}
