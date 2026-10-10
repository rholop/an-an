import { type Evidence, type ItemRef, type LearnerRepo, type Skill, type SkillCard } from '@anan/core';
import { type AnanDB, itemPk } from './schema.js';

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
    await this.db.markActiveDayFrom(events); // Phase 32: an answer makes its day active
  }

  /** Phase 21: like appendEvidence, but returns each row's sync uid (an undo refers to it). */
  async appendEvidenceUids(events: Evidence[]): Promise<string[]> {
    if (events.length === 0) return [];
    const ids = (await this.db.evidence.bulkAdd(events, { allKeys: true })) as number[];
    await this.db.markActiveDayFrom(events); // Phase 32: an answer makes its day active
    const rows = await this.db.evidence.bulkGet(ids);
    return rows.map((r) => r?.uid ?? '');
  }

  /** Phase 20: every card of one item (all skills). */
  async cardsOfItem(item: ItemRef): Promise<SkillCard[]> {
    const skills: Skill[] = ['recognition', 'production', 'listening', 'reading'];
    const rows = await this.db.items.bulkGet(skills.map((s) => itemPk(item, s)));
    return rows.filter((r): r is NonNullable<typeof r> => !!r).map(stripPk);
  }

  async allCards(): Promise<SkillCard[]> {
    return (await this.db.items.toArray()).map(stripPk);
  }

}
