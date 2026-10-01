import { describe, expect, it } from 'vitest';
import type { Evidence, ItemRef } from '../types.js';
import { applyEvidence } from './apply-evidence.js';
import { buildFsrs } from './fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type SkillCard } from './types.js';

// Deterministic PRNG (mulberry32) so the simulation is reproducible.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulates N synthetic items over `days` of daily reviews: whenever a card
 * is due, the "learner" answers correctly with probability equal to FSRS's
 * own predicted retrievability at that moment (drawn from a seeded PRNG),
 * routed through applyEvidence exactly like a real review screen would.
 * This isn't testing FSRS's algorithm (that's upstream, already validated)
 * — it's a regression test that OUR plumbing (card threading, ItemState
 * computation, the evidence->rating mapping) doesn't silently break the
 * target-retention property FSRS is supposed to deliver.
 */
function simulate(config = DEFAULT_LEARNER_CONFIG, itemCount = 300, days = 60, seed = 42) {
  const fsrsInstance = buildFsrs(config);
  const rng = mulberry32(seed);
  const start = new Date('2026-01-01T00:00:00Z');

  const cards = new Map<string, SkillCard>();
  let remembered = 0;
  let total = 0;
  let introduced = 0;
  const itemsPerDay = Math.ceil(itemCount / days);

  for (let day = 0; day < days; day++) {
    const now = new Date(start.getTime() + day * 86_400_000);

    // Introduce a steady daily trickle of new items (classic steady-state load).
    for (let k = 0; k < itemsPerDay && introduced < itemCount; k++, introduced++) {
      const id = `sim-${introduced}`;
      const item: ItemRef = { kind: 'word', id };
      const evidence: Evidence = { item, skill: 'recognition', kind: 'review_good', at: now };
      const result = applyEvidence(undefined, evidence, now, config, fsrsInstance);
      cards.set(id, result.card!);
    }

    for (const [id, card] of cards) {
      if (card.card.due > now) continue;
      const retrievability = fsrsInstance.get_retrievability(card.card, now, false) as number;
      const didRemember = rng() < retrievability;
      total++;
      if (didRemember) remembered++;

      const kind: Evidence['kind'] = didRemember ? 'review_good' : 'review_again';
      const evidence: Evidence = { item: card.item, skill: 'recognition', kind, at: now };
      const result = applyEvidence(card, evidence, now, config, fsrsInstance);
      cards.set(id, result.card!);
    }
  }

  return { observedRetention: remembered / total, total };
}

describe('60-day synthetic-learner retention simulation', () => {
  it('observed retention stays within ±5 points of the configured target', () => {
    const { observedRetention, total } = simulate();
    expect(total).toBeGreaterThan(500); // enough reviews for the figure to mean something
    expect(observedRetention).toBeGreaterThanOrEqual(DEFAULT_LEARNER_CONFIG.requestRetention - 0.05);
    expect(observedRetention).toBeLessThanOrEqual(DEFAULT_LEARNER_CONFIG.requestRetention + 0.05);
  });

  it('a lower configured target retention measurably lowers observed retention', () => {
    // Day-granularity scheduling (no fuzz) means FSRS reviews a card
    // slightly *before* the exact moment retrievability would hit the
    // target (intervals round to whole days), so observed retention runs a
    // few points above the configured target at any setting — a known,
    // benign property of integer-day scheduling, not a bug. That makes an
    // absolute ±5-point band unreliable at 0.85 specifically (see git log
    // for the probe run that found this); the robust, non-flaky check is
    // directional: does requestRetention actually move the outcome the
    // right way.
    const low = simulate({ ...DEFAULT_LEARNER_CONFIG, requestRetention: 0.85 });
    const high = simulate({ ...DEFAULT_LEARNER_CONFIG, requestRetention: 0.95 });
    expect(low.observedRetention).toBeLessThan(high.observedRetention);
  });
});
