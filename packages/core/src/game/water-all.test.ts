import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { planWaterAll, waterAllCards, wateredWordCount } from './water-all.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const card = (
  id: string,
  skill: SkillCard['skill'],
  dueOffsetH: number,
  over: Partial<SkillCard> = {},
): SkillCard => ({
  item: { kind: 'word', id },
  skill,
  card: {
    ...createEmptyCard(NOW),
    due: new Date(NOW.getTime() + dueOffsetH * 3_600_000),
    reps: 3,
    stability: 4,
  },
  state: 'review',
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  clozeRung: 1,
  clozeStreak: 0,
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  updatedAt: NOW,
  ...over,
});

describe('Water all (Phase 22 Part B)', () => {
  const cards = [
    card('捷運', 'recognition', -5),
    card('捷運', 'production', -1),
    card('機車', 'recognition', -30),
    card('便利商店', 'recognition', -2),
    card('垃圾車', 'recognition', 3), // later today: not thirsty yet
    card('還', 'recognition', -4, { flags: { snoozed: true } }), // Not now
    card('長', 'listening', -4), // its own queue
    { ...card('了', 'recognition', -4), item: { kind: 'grammar', id: 'gram-le' } },
  ];

  it('covers every word that needs water, and counts words not cards', () => {
    const due = waterAllCards(cards, NOW);
    expect(due).toHaveLength(4);
    expect(wateredWordCount(due)).toBe(3);
    expect(waterAllCards(cards, NOW, (id) => id !== '機車')).toHaveLength(3);
  });

  it('every card is in the session (siblings never dropped), mixing flashcards and clozes', () => {
    const many = Array.from({ length: 12 }, (_, i) => [
      card(`w${i}`, 'recognition', -1),
      card(`w${i}`, 'production', -1),
    ]).flat();
    const plan = planWaterAll(many, { seed: 'water-test', clozeFor: (c) => ({ id: c.item.id }) });
    expect(plan).toHaveLength(many.length);
    expect(new Set(plan.map((e) => e.card))).toEqual(new Set(many));
    const kinds = new Set(plan.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['flash', 'cloze']));
    // the same seed builds the same session
    expect(
      planWaterAll(many, { seed: 'water-test', clozeFor: (c) => ({ id: c.item.id }) }).map(
        (e) => e.kind,
      ),
    ).toEqual(plan.map((e) => e.kind));
  });

  it('a card with no possible cloze is a flashcard', () => {
    const plan = planWaterAll(waterAllCards(cards, NOW), { seed: 's', clozeFor: () => null });
    expect(plan.every((e) => e.kind === 'flash')).toBe(true);
    expect(plan).toHaveLength(4);
  });
});
