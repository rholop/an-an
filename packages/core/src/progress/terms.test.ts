import { describe, expect, it } from 'vitest';
import { createEmptyCard, State } from 'ts-fsrs';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import type { Evidence, ItemRef } from '../types.js';
import {
  inAppAnswers,
  isDueCard,
  isImportedOnly,
  isLearnedCard,
  isNewCard,
  lessonCoreItems,
  levelItems,
  productionUnlockFor,
  ProgressIndex,
  wordSets,
} from './terms.js';
import { PROGRESS_CONFIG } from './progress.config.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const DAY = 86_400_000;
const w = (id: string): ItemRef => ({ kind: 'word', id });

const card = (id: string, over: Partial<SkillCard> = {}, fsrs: Partial<SkillCard['card']> = {}): SkillCard => ({
  item: w(id),
  skill: 'recognition',
  card: { ...createEmptyCard(NOW), ...fsrs },
  state: 'introduced',
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
const ev = (id: string, kind: Evidence['kind'], skill: Evidence['skill'] = 'recognition', at = NOW): Evidence => ({
  item: w(id),
  skill,
  kind,
  at,
});

describe('Phase 21 shared terms: card level', () => {
  it('New = never answered; Due = answered and due now; New is never Due', () => {
    const fresh = card('a');
    expect(isNewCard(fresh)).toBe(true);
    expect(isDueCard(fresh, NOW)).toBe(false);
    const answered = applyEvidence(fresh, ev('a', 'review_good'), NOW).card!;
    expect(isNewCard(answered)).toBe(false);
    expect(isDueCard(answered, new Date(NOW.getTime() + 30 * DAY))).toBe(true);
    expect(isDueCard({ ...answered, state: 'unseen' }, new Date(NOW.getTime() + 30 * DAY))).toBe(false);
    expect(isDueCard({ ...answered, flags: { snoozed: true } }, new Date(NOW.getTime() + 30 * DAY))).toBe(false);
  });

  it('Anki / placement seeds are "Imported" (not Learned) until their first in-app review', () => {
    const seed = applyEvidence(undefined, ev('a', 'anki_import_seen'), NOW).card!;
    expect(isImportedOnly(seed)).toBe(true);
    expect(isLearnedCard(seed)).toBe(false);
    expect(inAppAnswers(seed)).toBe(0);
    const reviewed = applyEvidence(seed, ev('a', 'review_good', 'recognition', new Date(NOW.getTime() + 3 * DAY)), new Date(NOW.getTime() + 3 * DAY)).card!;
    expect(isImportedOnly(reviewed)).toBe(false);
    expect(isLearnedCard(reviewed)).toBe(true);
  });

  it('placement and Anki import never overwrite an existing card', () => {
    let c = applyEvidence(undefined, ev('a', 'review_again'), NOW).card!;
    expect(applyEvidence(c, ev('a', 'anki_import_seen'), NOW).card).toBeUndefined();
    expect(applyEvidence(c, ev('a', 'placement_known'), NOW).card).toBeUndefined();
    // an "unknown" placement row (state unseen) may still be upgraded by a later "known"
    c = applyEvidence(undefined, ev('b', 'placement_unknown'), NOW).card!;
    expect(applyEvidence(c, ev('b', 'placement_known'), NOW).card?.state).toBe('review');
  });

  it('"I already know this" sets Learned and Mastered (both skills) until a lapse contradicts it', () => {
    const r = applyEvidence(undefined, ev('a', 'known_check_passed'), NOW).card!;
    const p = applyEvidence(undefined, ev('a', 'known_check_passed', 'production'), NOW).card!;
    expect(r.card.state).toBe(State.Review);
    expect(r.card.stability).toBeGreaterThanOrEqual(PROGRESS_CONFIG.knownStabilityDays);
    const idx = new ProgressIndex({ cards: [r, p] });
    expect(idx.learned(w('a'))).toBe(true);
    expect(idx.mastered(w('a'))).toBe(true);
    const later = new Date(NOW.getTime() + 70 * DAY);
    const lapsed = applyEvidence(r, ev('a', 'review_again', 'recognition', later), later).card!;
    expect(new ProgressIndex({ cards: [lapsed, p] }).mastered(w('a'))).toBe(false);
  });

  it('a Learned recognition card unlocks the production card, once, through evidence', () => {
    const learned = card('a', { state: 'review' }, { state: State.Review, reps: 2, stability: 4 });
    const unlock = productionUnlockFor(learned, false, NOW)!;
    expect(unlock).toMatchObject({ kind: 'production_unlocked', skill: 'production', item: w('a') });
    expect(productionUnlockFor(learned, true, NOW)).toBeUndefined();
    expect(productionUnlockFor(card('b'), false, NOW)).toBeUndefined();
    const prod = applyEvidence(undefined, unlock, NOW).card!;
    expect(isNewCard(prod)).toBe(true);
    expect(applyEvidence(prod, unlock, NOW).card).toBeUndefined();
  });
});

describe('Phase 21 shared terms: items, lessons, levels', () => {
  const mastered = (id: string) => [
    card(id, { state: 'mature' }, { state: State.Review, reps: 5, stability: 30 }),
    card(id, { skill: 'production', state: 'review' }, { state: State.Review, reps: 3, stability: 10 }),
  ];

  it('Mastered = recognition ≥ 21 d and production ≥ 7 d; leeches are Learned but never Mastered', () => {
    const idx = new ProgressIndex({ cards: [...mastered('a'), ...mastered('b').map((c) => ({ ...c, leech: true }))] });
    expect(idx.status(w('a'))).toBe('mastered');
    expect(idx.learned(w('b'))).toBe(true);
    expect(idx.mastered(w('b'))).toBe(false);
    expect(idx.summarize([w('a'), w('b'), w('c')])).toMatchObject({ total: 3, learned: 2, mastered: 1, leeches: 1 });
  });

  it('grammar: 3 correct uses with the last correct (Review Good/Easy count too)', () => {
    const g: ItemRef = { kind: 'grammar', id: 'g1' };
    const idx = new ProgressIndex({ cards: [], grammarUses: new Map([['g1', { correct: 3, lastCorrect: true }]]) });
    expect(idx.mastered(g)).toBe(true);
    expect(new ProgressIndex({ cards: [], grammarUses: new Map([['g1', { correct: 1, lastCorrect: true }]]) }).status(g)).toBe('learned');
  });

  it('one lesson item set: vocab + grammar words − proper nouns, then grammar, de-duplicated', () => {
    const items = lessonCoreItems({
      vocab: ['捷運', '台北', '捷運'],
      grammarWords: ['了', '捷運'],
      properNouns: ['台北'],
      grammar: ['gram-le', 'gram-le'],
    });
    expect(items).toEqual([w('捷運'), w('了'), { kind: 'grammar', id: 'gram-le' }]);
  });

  it('one level item set: TOCFL-list words of that level only', () => {
    const items = levelItems('L1', [
      { id: '機車', source: 'tocfl', level: 'L1' },
      { id: '便利商店', source: 'tocfl', level: 'L2' },
      { id: '垃圾車', source: 'textbook', level: 'L1' },
    ]);
    expect(items).toEqual([w('機車')]);
  });

  it('comprehensible sets: Learned → known; answered → learning; New is not comprehensible', () => {
    const later = new Date(NOW.getTime() + 40 * DAY);
    const sets = wordSets(
      [
        ...mastered('還'),
        card('長', { state: 'learning' }, { state: State.Learning, reps: 1, due: new Date(NOW.getTime() + 60 * DAY) }),
        card('了'),
        applyEvidence(undefined, ev('機車', 'anki_import_seen'), NOW).card!,
      ],
      later,
    );
    expect([...sets.knownIds]).toEqual(['還']);
    expect(sets.learningIds.has('長')).toBe(true);
    expect(sets.learningIds.has('機車')).toBe(true); // imported: comprehensible, not Learned
    expect(sets.dueIds.has('機車')).toBe(true);
    expect(sets.newIds.has('了')).toBe(true);
    expect(sets.learningIds.has('了')).toBe(false);
  });
});
