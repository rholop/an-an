import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readingEvidence, type Evidence } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';
import { ensureFaceCards } from './face-cards.js';
import { sanitizeReviewSettings } from './review-settings.js';

let db: AnanDB;
let service: LearnerService;
const deps = () => ({ ledger: (n: Date) => service.ledger(n), recordBulk: (e: Evidence[], n: Date) => service.recordBulk(e, n) });

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  service = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

const NOW = new Date('2026-03-02T15:00:00Z');
const w = (id: string) => ({ kind: 'word' as const, id });

describe('Phase 23 face cards', () => {
  it('a word that reached learning gets its reading card once; New words and imports wait', async () => {
    await service.record({ item: w('a'), skill: 'recognition', kind: 'review_good', at: NOW }, NOW);
    await service.record({ item: w('b'), skill: 'recognition', kind: 'chat_lookup_gloss', at: NOW }, NOW);
    await service.recordBulk([{ item: w('c'), skill: 'recognition', kind: 'anki_import_seen', at: NOW }], NOW);
    // an answer alone writes only what it changes: no reading card yet
    expect(await service.getCard(w('a'), 'reading')).toBeUndefined();

    expect(await ensureFaceCards(NOW, deps())).toBe(1);
    expect((await service.getCard(w('a'), 'reading'))?.state).toBe('introduced');
    expect(await service.getCard(w('b'), 'reading')).toBeUndefined();
    expect(await service.getCard(w('c'), 'reading')).toBeUndefined();
    // safe to run again
    expect(await ensureFaceCards(NOW, deps())).toBe(0);
  });

  it('reading answers schedule the reading card and never touch recognition', async () => {
    await service.record({ item: w('a'), skill: 'recognition', kind: 'review_good', at: NOW }, NOW);
    await ensureFaceCards(NOW, deps());
    const before = await service.getCard(w('a'), 'recognition');
    const later = new Date(NOW.getTime() + 60_000);
    await service.record(readingEvidence({ wordId: 'a', kind: 'reading_tone_wrong', tones: [{ expected: 2, given: 3 }] }, later), later);
    const reading = await service.getCard(w('a'), 'reading');
    expect(reading?.card.reps).toBe(1);
    expect(reading?.card.due.getTime()).toBeGreaterThan(later.getTime());
    expect(await service.getCard(w('a'), 'recognition')).toEqual(before);
    const ev = await db.evidence.where('kind').equals('reading_tone_wrong').toArray();
    expect(ev[0]?.context?.tones).toEqual([{ expected: 2, given: 3 }]);
  });

  it('Nope takes the reading card out too, and Undo puts it back', async () => {
    await service.record({ item: w('a'), skill: 'recognition', kind: 'review_good', at: NOW }, NOW);
    await ensureFaceCards(NOW, deps());
    const h = await service.nope(w('a'), 'never', {}, NOW);
    expect((await service.getCard(w('a'), 'reading'))?.flags.excluded).toBeTruthy();
    await h.undo();
    expect((await service.getCard(w('a'), 'reading'))?.flags.excluded).toBeFalsy();
  });
});

describe('Phase 23 review settings', () => {
  it("Phase 20's daily cap becomes the cap per session; bad times fall back to the defaults", () => {
    const s = sanitizeReviewSettings({ dailyCap: 120 });
    expect(s.capPerSession).toBe(120);
    expect(s.timeZone).toBe('America/New_York');
    expect(s.morningOpens).toBe('04:00');
    expect(sanitizeReviewSettings({ timeZone: 'Not/AZone' }).timeZone).toBe('America/New_York');
    expect(sanitizeReviewSettings({ capPerSession: 80, dailyCap: 200 }).capPerSession).toBe(80);
  });
});
