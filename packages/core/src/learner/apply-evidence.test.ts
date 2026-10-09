import { describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import type { Evidence, ItemRef } from '../types.js';
import { applyEvidence } from './apply-evidence.js';
import { buildFsrs, emptyCard } from './fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type SkillCard } from './types.js';

const item: ItemRef = { kind: 'word', id: 'tocfl-abc123' };
const NOW = new Date('2026-01-01T00:00:00Z');
const config = DEFAULT_LEARNER_CONFIG;
const fsrsInstance = buildFsrs(config);

function ev(kind: Evidence['kind'], skill: Evidence['skill'] = 'recognition'): Evidence {
  return { item, skill, kind, at: NOW };
}

function freshCard(now = NOW, overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    item,
    skill: 'recognition',
    card: emptyCard(now),
    state: 'introduced',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
    ...overrides,
  };
}

describe('applyEvidence: purity', () => {
  it('never reads the wall clock — same (current, evidence, now) always produces the same update', () => {
    const current = freshCard();
    const a = applyEvidence(current, ev('review_good'), NOW, config, fsrsInstance);
    const b = applyEvidence(current, ev('review_good'), NOW, config, fsrsInstance);
    expect(a).toEqual(b);
  });

  it('does not mutate the `current` card it was given', () => {
    const current = freshCard();
    const snapshot = JSON.parse(JSON.stringify(current));
    applyEvidence(current, ev('review_good'), NOW, config, fsrsInstance);
    expect(JSON.parse(JSON.stringify(current))).toEqual(snapshot);
  });
});

describe('applyEvidence: direct FSRS mapping rows', () => {
  const directRows: [Evidence['kind'], string][] = [
    ['review_again', 'again'],
    ['review_hard', 'hard'],
    ['review_good', 'good'],
    ['review_easy', 'easy'],
    ['cloze_correct_nohint', 'good'],
    ['cloze_correct_hint', 'hard'],
    ['cloze_wrong', 'again'],
    ['journal_correct_use', 'good'],
    ['journal_misuse', 'hard'],
  ];

  it.each(directRows)('%s -> fsrs:%s', (kind, grade) => {
    const current = freshCard();
    const result = applyEvidence(current, ev(kind), NOW, config, fsrsInstance);
    expect(result.appliedEffect).toContain(`fsrs:${grade}`);
    expect(result.card).toBeDefined();
  });

  it('review_again on a never-seen item creates a card rather than throwing', () => {
    // A brand-new card's first rating being Again is normal initial
    // learning, not a "lapse" (FSRS only counts lapses on a Review-state
    // card failing) — so lapses stays 0 here; see the leech describe block
    // below for the actual lapse-accumulation case.
    const result = applyEvidence(undefined, ev('review_again'), NOW, config, fsrsInstance);
    expect(result.card).toBeDefined();
    expect(result.card!.card.reps).toBe(1);
    expect(result.card!.lapses).toBe(0);
  });

  it('journal_misuse is Hard, not Again (CLAUDE.md: "partial lapse", not a full lapse)', () => {
    const current = freshCard();
    const result = applyEvidence(current, ev('journal_misuse'), NOW, config, fsrsInstance);
    expect(result.card!.lapses).toBe(0); // Hard does not increment FSRS lapses
  });
});

describe('applyEvidence: cloze difficulty ladder (clozeRung/clozeStreak)', () => {
  it('a plain review_* evidence kind leaves clozeRung/clozeStreak untouched', () => {
    const current = freshCard(NOW, { clozeRung: 2, clozeStreak: 1 });
    const result = applyEvidence(current, ev('review_good'), NOW, config, fsrsInstance);
    expect(result.card!.clozeRung).toBe(2);
    expect(result.card!.clozeStreak).toBe(1);
  });

  it('promotes after 2 consecutive cloze_correct_nohint at the same rung', () => {
    let current = freshCard(NOW, { clozeRung: 1, clozeStreak: 0 });
    current = applyEvidence(current, ev('cloze_correct_nohint'), NOW, config, fsrsInstance).card!;
    expect(current.clozeRung).toBe(1);
    expect(current.clozeStreak).toBe(1);

    current = applyEvidence(current, ev('cloze_correct_nohint'), NOW, config, fsrsInstance).card!;
    expect(current.clozeRung).toBe(2);
    expect(current.clozeStreak).toBe(0);
  });

  it('cloze_correct_hint ("right word, wrong tone") resets the streak without demoting', () => {
    const current = freshCard(NOW, { clozeRung: 2, clozeStreak: 1 });
    const result = applyEvidence(current, ev('cloze_correct_hint'), NOW, config, fsrsInstance);
    expect(result.card!.clozeRung).toBe(2);
    expect(result.card!.clozeStreak).toBe(0);
  });

  it('cloze_wrong demotes one rung and resets the streak', () => {
    const current = freshCard(NOW, { clozeRung: 3, clozeStreak: 1 });
    const result = applyEvidence(current, ev('cloze_wrong'), NOW, config, fsrsInstance);
    expect(result.card!.clozeRung).toBe(2);
    expect(result.card!.clozeStreak).toBe(0);
  });

  it('cloze_wrong on a brand-new item starts the ladder at rung 1, not below', () => {
    const result = applyEvidence(undefined, ev('cloze_wrong'), NOW, config, fsrsInstance);
    expect(result.card!.clozeRung).toBe(1);
    expect(result.card!.clozeStreak).toBe(0);
  });
});

describe('applyEvidence: weak signals never produce a full FSRS review on their own', () => {
  it('chat_read_no_lookup on a never-introduced item is a pure no-op', () => {
    const result = applyEvidence(undefined, ev('chat_read_no_lookup'), NOW, config, fsrsInstance);
    expect(result.card).toBeUndefined();
    expect(result.appliedEffect).toBe('ignored:unseen-weak-signal');
  });

  /** A card answered once and still learning (read credit needs an answer, Phase 29 Part B.11). */
  const learning = (due: Date, over: Partial<SkillCard> = {}): SkillCard =>
    freshCard(NOW, { card: { ...emptyCard(NOW), due, reps: 1, state: 1 }, state: 'learning', ...over });

  it('Phase 29: a New (never answered) or Nope\'d card never gets read credit', () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    const fresh = freshCard(NOW, { card: { ...emptyCard(NOW), due: past }, familiarity: config.readNoLookupGoodThreshold - 1 });
    expect(applyEvidence(fresh, ev('chat_read_no_lookup'), NOW, config, fsrsInstance)).toMatchObject({
      card: undefined,
      appliedEffect: 'ignored:not-scheduled',
    });
    const noped = learning(past, { flags: { snoozed: true }, familiarity: config.readNoLookupGoodThreshold - 1 });
    expect(applyEvidence(noped, ev('chat_read_no_lookup'), NOW, config, fsrsInstance).card).toBeUndefined();
  });

  it('chat_read_no_lookup below the occurrence threshold only nudges familiarity, never touches the FSRS card', () => {
    const current = learning(new Date(NOW.getTime() - 86_400_000));
    const before = current.card;
    const result = applyEvidence(current, ev('chat_read_no_lookup'), NOW, config, fsrsInstance);
    expect(result.card!.card).toBe(before); // same object: FSRS card untouched
    expect(result.card!.familiarity).toBe(1);
    expect(config.readNoLookupGoodThreshold).toBeGreaterThan(1); // sanity: threshold is genuinely >1
  });

  it('chat_read_no_lookup below threshold does NOT apply even when due, until the threshold is reached', () => {
    let current = learning(new Date(NOW.getTime() - 86_400_000));
    for (let i = 1; i < config.readNoLookupGoodThreshold; i++) {
      const r = applyEvidence(current, ev('chat_read_no_lookup'), NOW, config, fsrsInstance);
      expect(r.appliedEffect).toMatch(/^familiarity:/);
      current = r.card!;
    }
    expect(current.card.reps).toBe(1); // no FSRS review from reading alone
  });

  it('chat_read_no_lookup reaching the threshold WHILE due finally counts as Good', () => {
    const current = learning(new Date(NOW.getTime() - 86_400_000), { familiarity: config.readNoLookupGoodThreshold - 1 });
    const result = applyEvidence(current, ev('chat_read_no_lookup'), NOW, config, fsrsInstance);
    expect(result.appliedEffect).toContain('fsrs:good');
    expect(result.card!.familiarity).toBe(0); // counter resets
  });

  it('chat_read_no_lookup reaching the threshold while NOT due stays a familiarity nudge, never an FSRS review', () => {
    const current = learning(new Date(NOW.getTime() + 86_400_000), { familiarity: config.readNoLookupGoodThreshold - 1 });
    const before = current.card;
    const result = applyEvidence(current, ev('chat_read_no_lookup'), NOW, config, fsrsInstance);
    expect(result.card!.card).toBe(before);
    expect(result.appliedEffect).toMatch(/^familiarity:/);
  });

  it('chat_hover_reading never touches the FSRS card, only readingDependence', () => {
    const current = freshCard();
    const before = current.card;
    const result = applyEvidence(current, ev('chat_hover_reading'), NOW, config, fsrsInstance);
    expect(result.card!.card).toBe(before);
    expect(result.card!.readingDependence).toBeCloseTo(config.readingDependenceStep);
  });

  it('chat_hover_reading on a never-introduced item is a no-op', () => {
    const result = applyEvidence(undefined, ev('chat_hover_reading'), NOW, config, fsrsInstance);
    expect(result.card).toBeUndefined();
  });

  it('chat_hover_reading clamps readingDependence to [0,1]', () => {
    const current = freshCard(NOW, { readingDependence: 0.95 });
    const result = applyEvidence(current, ev('chat_hover_reading'), NOW, config, fsrsInstance);
    expect(result.card!.readingDependence).toBeLessThanOrEqual(1);
  });
});

describe('applyEvidence: chat_lookup_gloss', () => {
  it('introduces a never-seen item without consuming an FSRS rating', () => {
    const result = applyEvidence(undefined, ev('chat_lookup_gloss'), NOW, config, fsrsInstance);
    expect(result.appliedEffect).toBe('introduce');
    expect(result.card!.state).toBe('introduced');
    expect(result.card!.card.reps).toBe(0);
  });

  it('is Again when the card is already in review (forgot something learned)', () => {
    const current = freshCard(NOW, {
      state: 'review',
      card: { ...emptyCard(NOW), state: State.Review, stability: 5, difficulty: 5 },
    });
    const result = applyEvidence(current, ev('chat_lookup_gloss'), NOW, config, fsrsInstance);
    expect(result.appliedEffect).toContain('fsrs:again');
    expect(result.card!.lapses).toBe(1);
  });

  it('is a no-op (not a lapse) when the card is only introduced/learning, not yet in review', () => {
    const current = freshCard(NOW, { state: 'learning' });
    const result = applyEvidence(current, ev('chat_lookup_gloss'), NOW, config, fsrsInstance);
    expect(result.appliedEffect).toBe('ignored:already-introduced');
    expect(result.card!.lapses).toBe(0);
  });
});

describe('applyEvidence: init-only evidence (anki_import_seen, placement_*)', () => {
  it('anki_import_seen sets state review with conservative stability, flagged imported', () => {
    const result = applyEvidence(undefined, ev('anki_import_seen'), NOW, config, fsrsInstance);
    expect(result.card!.state).toBe('review');
    expect(result.card!.card.stability).toBe(config.importedInitialStability);
    expect(result.card!.flags.imported).toBe(true);
  });

  it('placement_known sets an initial review state, flagged probablyKnown', () => {
    const result = applyEvidence(undefined, ev('placement_known'), NOW, config, fsrsInstance);
    expect(result.card!.state).toBe('review');
    expect(result.card!.flags.probablyKnown).toBe(true);
    expect(result.card!.card.stability).toBeGreaterThan(0);
  });

  it('placement_unknown sets state unseen with no progress', () => {
    const result = applyEvidence(undefined, ev('placement_unknown'), NOW, config, fsrsInstance);
    expect(result.card!.state).toBe('unseen');
    expect(result.card!.card.reps).toBe(0);
  });
});

describe('applyEvidence: leech flag', () => {
  // FSRS only increments `lapses` on a Review-state card receiving Again
  // (not on repeated Agains during relearning steps), so to exercise the
  // threshold directly we construct a card already one lapse away from it
  // rather than simulating a full multi-day relearning sequence.
  it('does not flag leech one lapse below the threshold', () => {
    const current = freshCard(NOW, {
      state: 'review',
      card: { ...emptyCard(NOW), state: State.Review, stability: 5, difficulty: 5, lapses: config.leechThreshold - 2 },
    });
    const result = applyEvidence(current, ev('review_again'), NOW, config, fsrsInstance);
    expect(result.card!.lapses).toBe(config.leechThreshold - 1);
    expect(result.card!.leech).toBe(false);
  });

  it('flags leech exactly when lapses reach the configured threshold', () => {
    const current = freshCard(NOW, {
      state: 'review',
      card: { ...emptyCard(NOW), state: State.Review, stability: 5, difficulty: 5, lapses: config.leechThreshold - 1 },
    });
    const result = applyEvidence(current, ev('review_again'), NOW, config, fsrsInstance);
    expect(result.card!.lapses).toBe(config.leechThreshold);
    expect(result.card!.leech).toBe(true);
  });
});
