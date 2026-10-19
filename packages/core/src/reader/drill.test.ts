import { describe, expect, it } from 'vitest';
import { drillScore } from './drill.js';
import { TEST_PREP_CONFIG } from '../progress/test-prep.js';

describe('Phase 49: the drill timer', () => {
  it('running out of time is "slow", never wrong: "4 / 5 right · 3 within time"', () => {
    const per = TEST_PREP_CONFIG.secondsPerItem;
    const s = drillScore([
      { correct: true, seconds: 20 },
      { correct: true, seconds: per + 30 },
      { correct: true, seconds: per },
      { correct: false, seconds: 10 },
      { correct: true, seconds: per * 3 },
    ]);
    expect(s).toEqual({ right: 4, inTime: 3, total: 5 });
  });
});

import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { buildLedger } from '../progress/ledger.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate } from '../progress/review-sessions.js';
import type { Evidence } from '../types.js';
import { drillAnswerEvidence } from './drill.js';

describe('Phase 49: drill answers count like practice', () => {
  const TZ = 'America/New_York';
  const at = (d: number, h: number) => zonedDate(2026, 10, d, h, 0, TZ);
  const first: Evidence = { item: { kind: 'word', id: 'w1' }, skill: 'recognition', kind: 'review_good', at: at(10, 9) };
  const card0 = applyEvidence(undefined, first, first.at).card!;
  const ledgerAt = (now: Date, cards: SkillCard[], evidence: Evidence[]) =>
    buildLedger({ cards, evidence, knownItems: [], session: { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ }, masteryShare: 0.8, now });

  it('the day\'s first answer is a counted review that moves FSRS; a second the same day is practice only', () => {
    const now = at(20, 13);
    const a = drillAnswerEvidence(ledgerAt(now, [card0], [first]), { wordId: 'w1', id: 'gap:w1:s1' }, true, now);
    expect(a.map((e) => e.kind)).toEqual(['review_good', 'drill_correct']);
    expect(a[0]!.context).toMatchObject({ source: 'drill', practice: true, face: 'meaning' });
    const moved = applyEvidence(card0, a[0]!, now).card!;
    expect(moved.card.reps).toBe(card0.card.reps + 1);
    const later = at(20, 14);
    const b = drillAnswerEvidence(ledgerAt(later, [moved], [first, ...a]), { wordId: 'w1', id: 'meaning:w1:s2' }, false, later);
    expect(b.map((e) => e.kind)).toEqual(['practice_again', 'drill_wrong']);
    expect(applyEvidence(moved, b[0]!, later).card?.card.reps ?? moved.card.reps).toBe(moved.card.reps);
    // the drill result itself never moves a card
    expect(applyEvidence(moved, b[1]!, later).card).toBeUndefined();
  });

  it('a word with no answered Meaning card only stores the drill result (no new word, no new face)', () => {
    const now = at(20, 13);
    expect(drillAnswerEvidence(ledgerAt(now, [card0], [first]), { wordId: 'w2', id: 'x' }, true, now).map((e) => e.kind)).toEqual(['drill_correct']);
  });
});
