import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let service: LearnerService;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  service = new LearnerService(new DexieLearnerRepo(db));
});

afterEach(async () => {
  await db.delete();
});

const NOW = new Date('2026-01-01');
const item = { kind: 'word' as const, id: 'w1' };

describe('LearnerService.record', () => {
  it('creates a card on first evidence and persists it', async () => {
    // A rated review (Good) moves a brand-new FSRS card straight to its
    // Learning state — 'introduced' is reserved for a card that exists but
    // has never had a rating applied yet (see chat_lookup_gloss's
    // "introduce" effect in apply-evidence.ts).
    const evidence: Evidence = { item, skill: 'recognition', kind: 'review_good', at: NOW };
    const card = await service.record(evidence, NOW);
    expect(card?.state).toBe('learning');
    expect(await service.getCard(item, 'recognition')).toEqual(card);
  });

  it('appends evidence to the log', async () => {
    const evidence: Evidence = { item, skill: 'recognition', kind: 'review_good', at: NOW };
    await service.record(evidence, NOW);
    const rows = await db.evidence.toArray();
    expect(rows).toHaveLength(1);
  });

  it('subsequent evidence reads the just-persisted card (not stale)', async () => {
    await service.record({ item, skill: 'recognition', kind: 'review_good', at: NOW }, NOW);
    const second = await service.record(
      { item, skill: 'recognition', kind: 'review_good', at: new Date(NOW.getTime() + 86_400_000) },
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(second!.card.reps).toBe(2);
  });
});

describe('LearnerService.recordBulk', () => {
  it('applies many evidence events with one read pass and one write pass, correctly', async () => {
    const events: Evidence[] = Array.from({ length: 50 }, (_, i) => ({
      item: { kind: 'word', id: `bulk-${i}` },
      skill: 'recognition',
      kind: 'anki_import_seen',
      at: NOW,
    }));
    const cards = await service.recordBulk(events, NOW);
    expect(cards).toHaveLength(50);
    expect(cards.every((c) => c.state === 'review' && c.flags.imported)).toBe(true);
    expect(await db.items.count()).toBe(50);
    expect(await db.evidence.count()).toBe(50);
  });
});

describe('LearnerService.dueCards / knownSet', () => {
  it('dueCards and knownSet reflect recorded evidence', async () => {
    await service.record({ item, skill: 'recognition', kind: 'anki_import_seen', at: NOW }, NOW);
    const known = await service.knownSet('review');
    expect(known.has('w1')).toBe(true);
  });
});
