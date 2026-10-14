// Phase 42 (owner, 2026-10-14): Mastered = Meaning and production each rated Easy 3 times; each such
// card comes back once about two weeks later: Easy keeps it, anything else un-masters it.
import { describe, expect, it } from 'vitest';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';
import { ProgressIndex } from './terms.js';
import { PROGRESS_CONFIG } from './progress.config.js';
import { recheckDue } from './easy-ratings.js';
import { sessionCards } from './review-status.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate } from './review-sessions.js';

const TZ = 'America/New_York';
const day = (d: number, h = 9) => zonedDate(2026, 10, d, h, 0, TZ);
const item = { kind: 'word' as const, id: 'w1' };
type Kind = 'review_again' | 'review_hard' | 'review_good' | 'review_easy';
const ev = (skill: 'recognition' | 'production', kind: Kind, at: Date): Evidence => ({ item, skill, kind, at });

function run(events: Evidence[]) {
  const cards = new Map<string, SkillCard>();
  for (const e of events) {
    const next = applyEvidence(cards.get(e.skill), e, e.at).card;
    if (next) cards.set(e.skill, next);
  }
  return cards;
}
const mastered = (cards: Map<string, SkillCard>) =>
  new ProgressIndex({ cards: [...cards.values()] }).mastered(item);
const easy = (skill: 'recognition' | 'production', from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ev(skill, 'review_easy', day(from + i)));

describe('Phase 42: Mastered needs 3 Easy ratings on Meaning and on production', () => {
  it('2 Easy on each is not enough, 3 on each is, 3 on only one is not', () => {
    expect(mastered(run([...easy('recognition', 1, 2), ...easy('production', 1, 2)]))).toBe(false);
    expect(mastered(run([...easy('recognition', 1, 3)]))).toBe(false);
    expect(mastered(run([...easy('recognition', 1, 3), ...easy('production', 1, 3)]))).toBe(true);
  });

  it('Good and Hard do not count and do not reset; Again resets', () => {
    const base = [...easy('production', 1, 3), ...easy('recognition', 1, 2)];
    expect(mastered(run([...base, ev('recognition', 'review_good', day(4))]))).toBe(false);
    expect(mastered(run([...base, ev('recognition', 'review_good', day(4)), ev('recognition', 'review_easy', day(5))]))).toBe(true);
    expect(mastered(run([...base, ev('recognition', 'review_again', day(4)), ev('recognition', 'review_easy', day(5))]))).toBe(false);
  });
});

describe('Phase 42: the two-week re-check', () => {
  const both = run([...easy('recognition', 1, 3), ...easy('production', 1, 3)]);
  const earned = day(3);

  it('is due 14 days after the third Easy, not before', () => {
    const c = both.get('recognition')!;
    expect(recheckDue(c, new Date(earned.getTime() + 13 * 86_400_000))).toBe(false);
    expect(recheckDue(c, new Date(earned.getTime() + 14 * 86_400_000))).toBe(true);
  });

  it('is in the review session once due, even though FSRS would not show it yet', () => {
    const now = day(18);
    const { cards } = sessionCards({
      cards: [...both.values()],
      evidence: [],
      now,
      settings: { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ },
    });
    expect(cards.map((c) => c.skill).sort()).toEqual(['production', 'recognition']);
    expect(
      sessionCards({ cards: [...both.values()], evidence: [], now: day(10), settings: { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ } }).cards,
    ).toHaveLength(0);
  });

  it('Easy at the re-check keeps the word Mastered and the card is not sent back again', () => {
    const after = run([...easy('recognition', 1, 3), ...easy('production', 1, 3), ev('recognition', 'review_easy', day(18)), ev('production', 'review_easy', day(18))]);
    expect(mastered(after)).toBe(true);
    expect(recheckDue(after.get('recognition')!, day(60))).toBe(false);
  });

  it('anything but Easy at the re-check un-masters the word, and it can be mastered again', () => {
    const base = [...easy('recognition', 1, 3), ...easy('production', 1, 3)];
    const slipped = run([...base, ev('recognition', 'review_good', day(18)), ev('production', 'review_easy', day(18))]);
    expect(mastered(slipped)).toBe(false);
    const again = run([...base, ev('recognition', 'review_good', day(18)), ...easy('recognition', 19, 3), ev('production', 'review_easy', day(18))]);
    expect(mastered(again)).toBe(true);
  });
});

describe('Phase 42: words Mastered under the old stability rule stay Mastered', () => {
  it('a card past the old thresholds counts as fully rated, and is never sent back', () => {
    const cards = run([ev('recognition', 'review_good', day(1)), ev('production', 'review_good', day(1))]);
    for (const [k, c] of cards)
      cards.set(k, { ...c, card: { ...c.card, stability: k === 'recognition' ? PROGRESS_CONFIG.mastered.recognitionStabilityDays : PROGRESS_CONFIG.mastered.productionStabilityDays } });
    expect(mastered(cards)).toBe(true);
    expect(recheckDue(cards.get('recognition')!, day(30))).toBe(false);
  });
});

describe('Phase 42: Rate your words (the learner’s own rating, no review)', () => {
  const rate = (skill: 'recognition' | 'production', kind: 'face_rating_good' | 'face_rating_easy' | 'face_rating_not_yet', at: Date): Evidence => ({ item, skill, kind, at });
  const seen = () => run([ev('recognition', 'review_hard', day(1)), ev('production', 'review_hard', day(1))]);

  it('Good sets the marker, Easy also counts as one Easy, neither moves the FSRS card', () => {
    const cards = seen();
    const before = cards.get('recognition')!;
    const good = applyEvidence(before, rate('recognition', 'face_rating_good', day(2)), day(2)).card!;
    expect(good.flags.knownFace).toBe(true);
    expect(good.flags.easyCount ?? 0).toBe(0);
    expect(good.card.due).toEqual(before.card.due);
    expect(good.card.stability).toBe(before.card.stability);
    const easy = applyEvidence(good, rate('recognition', 'face_rating_easy', day(3)), day(3)).card!;
    expect(easy.flags.easyCount).toBe(1);
  });

  it('three Easy ratings on both cards master the word', () => {
    let cards = seen();
    for (const d of [2, 3, 4])
      for (const skill of ['recognition', 'production'] as const) {
        const next = applyEvidence(cards.get(skill), rate(skill, 'face_rating_easy', day(d)), day(d)).card!;
        cards = new Map(cards).set(skill, next);
      }
    expect(mastered(cards)).toBe(true);
  });

  it('Not yet closes the marker and clears the Easy count, even on an old Learned card', () => {
    const cards = seen();
    const c = applyEvidence(cards.get('recognition'), rate('recognition', 'face_rating_not_yet', day(2)), day(2)).card!;
    expect(c.flags.knownFace).toBe(false);
    expect(c.flags.easyCount).toBe(0);
  });

  it('a card nobody has seen is left alone', () => {
    expect(applyEvidence(undefined, rate('recognition', 'face_rating_good', day(2)), day(2)).card).toBeUndefined();
  });
});
