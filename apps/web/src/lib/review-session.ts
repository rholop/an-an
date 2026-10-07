import {
  describeSkillCard,
  orderSession,
  studyRank,
  type ItemRef,
  type Lesson,
  type OrderedSession,
  type SkillCard,
  type StudyFocus,
} from '@anan/core';

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
  return orderSession(
    [...(input.fresh ?? []), ...input.due],
    (c) => describeSkillCard(c, { band: fresh.has(c) ? 0 : 1 + rank(c.item) }),
    { seed: input.seed, recent: input.recent },
  );
}

/** "Study this lesson" vocabulary: the lesson's due words, recognition cards only (Mandarin →
 * English: new words are met that way first; production comes in later sessions). */
export function lessonVocabCards(
  due: readonly SkillCard[],
  lesson: Pick<Lesson, 'vocab' | 'grammarWords'>,
  max = 25,
): SkillCard[] {
  const ids = new Set([...lesson.vocab, ...(lesson.grammarWords ?? [])]);
  return due.filter((c) => c.item.kind === 'word' && c.skill === 'recognition' && ids.has(c.item.id)).slice(0, max);
}
