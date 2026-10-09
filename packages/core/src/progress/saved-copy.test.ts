import { describe, expect, it } from 'vitest';
import { summarizeSavedCopy } from './saved-copy.js';

const card = (id: string, over: Record<string, unknown> = {}) => ({
  item: { kind: 'word', id },
  skill: 'recognition',
  card: { due: '2026-11-01T00:00:00.000Z', stability: 30, difficulty: 5, elapsed_days: 3, scheduled_days: 30, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: '2026-10-01T00:00:00.000Z' },
  state: 'review',
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  clozeRung: 1,
  clozeStreak: 0,
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('summarizeSavedCopy (Phase 28)', () => {
  it('counts cards, Learned, Mastered and evidence from a JSON copy', () => {
    const s = summarizeSavedCopy({
      items: [card('捷運'), card('機車', { state: 'unseen', card: { ...card('x').card, reps: 0, state: 0 } })],
      evidence: [{ at: '2026-10-01T09:00:00.000Z' }, { at: '2026-10-02T13:58:00.000Z' }],
      settings: {},
    });
    expect(s).toEqual({ cards: 1, learned: 1, mastered: 0, evidence: 2, lastEvidenceAt: '2026-10-02T13:58:00.000Z' });
  });

  it('treats a missing or broken copy as empty', () => {
    expect(summarizeSavedCopy(null)).toEqual({ cards: 0, learned: 0, mastered: 0, evidence: 0, lastEvidenceAt: null });
    expect(summarizeSavedCopy({ items: 'nope' }).cards).toBe(0);
  });
});
