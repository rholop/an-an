import type { Evidence, ItemRef, ItemState, LearnerRepo, Skill, SkillCard } from '@anan/core';
import { type AnanDB, itemPk } from './schema.js';

const ITEM_STATE_ORDER: ItemState[] = ['unseen', 'introduced', 'learning', 'review', 'mature'];

function stripPk(row: SkillCard & { pk: string }): SkillCard {
  const { pk: _pk, ...rest } = row;
  return rest;
}

export class DexieLearnerRepo implements LearnerRepo {
  constructor(private db: AnanDB) {}

  async getCard(item: ItemRef, skill: Skill): Promise<SkillCard | undefined> {
    const row = await this.db.items.get(itemPk(item, skill));
    return row ? stripPk(row) : undefined;
  }

  async putCards(cards: SkillCard[]): Promise<void> {
    if (cards.length === 0) return;
    await this.db.items.bulkPut(cards.map((c) => ({ ...c, pk: itemPk(c.item, c.skill) })));
  }

  async appendEvidence(events: Evidence[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.evidence.bulkAdd(events);
  }

  /** Phase 16: like appendEvidence, but returns the stored row ids (for undo). */
  async appendEvidenceKeys(events: Evidence[]): Promise<number[]> {
    if (events.length === 0) return [];
    return (await this.db.evidence.bulkAdd(events, { allKeys: true })) as number[];
  }

  /** Phase 16: removes one evidence row and puts a card back exactly as it was
   * (or deletes it when it didn't exist before). */
  async undoEvidence(evidenceId: number, item: ItemRef, skill: Skill, prior: SkillCard | undefined): Promise<void> {
    await this.db.transaction('rw', this.db.items, this.db.evidence, async () => {
      await this.db.evidence.delete(evidenceId);
      if (prior) await this.db.items.put({ ...prior, pk: itemPk(item, skill) });
      else await this.db.items.delete(itemPk(item, skill));
    });
  }

  async dueCards(now: Date, limit: number): Promise<SkillCard[]> {
    // Phase 15: listening cards are their own queue (`dueListeningCards`), never part of plain review.
    const rows = await this.db.items
      .where('card.due')
      .belowOrEqual(now)
      .filter((r) => r.skill !== 'listening')
      .limit(limit)
      .toArray();
    return rows.map(stripPk);
  }

  async dueListeningCards(now: Date, limit: number): Promise<SkillCard[]> {
    const rows = await this.db.items
      .where('card.due')
      .belowOrEqual(now)
      .filter((r) => r.skill === 'listening')
      .limit(limit)
      .toArray();
    return rows.map(stripPk);
  }

  async knownSet(minState: ItemState): Promise<Set<string>> {
    const minIdx = ITEM_STATE_ORDER.indexOf(minState);
    const ids = new Set<string>();
    await this.db.items.each((row) => {
      if (row.skill !== 'listening' && ITEM_STATE_ORDER.indexOf(row.state) >= minIdx) ids.add(row.item.id);
    });
    return ids;
  }
}
