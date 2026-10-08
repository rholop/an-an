import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import type { Evidence, Skill } from '../types.js';
import { capMixedCards, nextProductionRung, productionRung, reviewFace } from './faces.js';

const NOW = new Date('2026-10-08T12:00:00Z');
function card(id: string, skill: Skill, over: Partial<SkillCard> = {}): SkillCard {
  return {
    item: { kind: 'word', id },
    skill,
    card: { ...createEmptyCard(NOW), due: new Date(NOW.getTime() - 3_600_000), reps: 3, stability: 3, difficulty: 5, state: 2, last_review: new Date(NOW.getTime() - 3 * 86_400_000) },
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
  };
}

const ans = (kind: Evidence['kind'], face: 'pick' | 'recall', at: Date): Evidence => ({
  item: { kind: 'word', id: '捷運' },
  skill: 'production',
  kind,
  at,
  context: { source: 'review', face },
});

describe('Review faces (Phase 23 Part B)', () => {
  it('each skill has its face: Meaning, Pick/Recall, Say it', () => {
    expect(reviewFace(card('a', 'recognition'))).toBe('meaning');
    expect(reviewFace(card('a', 'production'))).toBe('pick');
    expect(reviewFace(card('a', 'production', { card: { ...card('a', 'production').card, stability: 30 } }))).toBe('recall');
    expect(reviewFace(card('a', 'reading'))).toBe('say');
    expect(reviewFace({ ...card('g', 'recognition'), item: { kind: 'grammar', id: 'gram-le' } })).toBe('grammar');
  });

  it('the production ladder: Pick → Recall after 2 correct picks in a row, back after a lapse', () => {
    let c: SkillCard | undefined = card('捷運', 'production');
    expect(productionRung(c)).toBe('pick');
    c = applyEvidence(c, ans('review_good', 'pick', NOW), NOW).card!;
    expect(c).toMatchObject({ prodRung: 'pick', prodStreak: 1 });
    // a wrong pick resets the streak
    c = applyEvidence(c, ans('review_again', 'pick', NOW), NOW).card!;
    expect(c).toMatchObject({ prodRung: 'pick', prodStreak: 0 });
    c = applyEvidence(c, ans('review_good', 'pick', NOW), NOW).card!;
    c = applyEvidence(c, ans('review_hard', 'pick', NOW), NOW).card!;
    expect(c.prodRung).toBe('recall');
    expect(reviewFace(c)).toBe('recall');
    c = applyEvidence(c, ans('review_good', 'recall', NOW), NOW).card!;
    expect(c.prodRung).toBe('recall');
    c = applyEvidence(c, ans('review_again', 'recall', NOW), NOW).card!;
    expect(c).toMatchObject({ prodRung: 'pick', prodStreak: 0 });
  });

  it('answers without a face (cloze, old clients) leave the ladder alone', () => {
    const c = applyEvidence(card('x', 'production', { prodRung: 'pick', prodStreak: 1 }), { ...ans('review_good', 'pick', NOW), context: { source: 'review' } }, NOW).card!;
    expect(c).toMatchObject({ prodRung: 'pick', prodStreak: 1 });
    expect(nextProductionRung({ state: 'review', card: c.card }, 'pick', true)).toEqual({ prodRung: 'pick', prodStreak: 1 });
  });

  it('a capped session mixes skills about 40 / 40 / 20', () => {
    const due = [
      ...Array.from({ length: 60 }, (_, i) => card(`r${i}`, 'recognition')),
      ...Array.from({ length: 60 }, (_, i) => card(`p${i}`, 'production')),
      ...Array.from({ length: 60 }, (_, i) => card(`s${i}`, 'reading')),
    ];
    const picked = capMixedCards(due, { remaining: 50, now: NOW });
    const count = (s: Skill) => picked.filter((c) => c.skill === s).length;
    expect(picked).toHaveLength(50);
    expect(count('recognition')).toBe(20);
    expect(count('production')).toBe(20);
    expect(count('reading')).toBe(10);
  });

  it('room a skill cannot use goes to the others; nothing is dropped when everything fits', () => {
    const due = [
      ...Array.from({ length: 40 }, (_, i) => card(`r${i}`, 'recognition')),
      ...Array.from({ length: 3 }, (_, i) => card(`s${i}`, 'reading')),
    ];
    const picked = capMixedCards(due, { remaining: 30, now: NOW });
    expect(picked).toHaveLength(30);
    expect(picked.filter((c) => c.skill === 'reading')).toHaveLength(3);
    expect(capMixedCards(due, { remaining: 100, now: NOW })).toHaveLength(43);
  });
});
