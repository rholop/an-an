import { isActiveCard, isDueCard, isNewCard, type Evidence, type ItemRef, type LearnerRepo, type Skill, type SkillCard } from '@anan/core';
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
  }

  /** Phase 21: like appendEvidence, but returns each row's sync uid (an undo refers to it). */
  async appendEvidenceUids(events: Evidence[]): Promise<string[]> {
    if (events.length === 0) return [];
    const ids = (await this.db.evidence.bulkAdd(events, { allKeys: true })) as number[];
    const rows = await this.db.evidence.bulkGet(ids);
    return rows.map((r) => r?.uid ?? '');
  }

  async dueCards(now: Date, limit: number): Promise<SkillCard[]> {
    // Phase 15: listening cards are their own queue (`dueListeningCards`), never part of plain review.
    // Phase 20: "Not now" and "Never show" cards are out of every queue. (The daily cap is applied
    // by the review session, which knows the study order.)
    const rows = await this.db.items
      .where('card.due')
      .belowOrEqual(now)
      // Phase 21: Due = answered at least once (core `isDueCard`): an `unseen` row (placement
      // "don't know", an undone first answer) or a never-answered `introduced` card (that is New) is never due.
      .filter((r) => r.skill !== 'listening' && isDueCard(r, now))
      .limit(Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER)
      .toArray();
    return rows.map(stripPk);
  }

  /** Phase 21: New cards (introduced, never answered), any skill but listening, still in the queues. */
  async newCards(): Promise<SkillCard[]> {
    const rows = await this.db.items
      .where('state')
      .equals('introduced')
      .filter((r) => r.skill !== 'listening' && isNewCard(r) && isActiveCard(r))
      .toArray();
    return rows.map(stripPk);
  }

  async dueListeningCards(now: Date, limit: number): Promise<SkillCard[]> {
    const rows = await this.db.items
      .where('card.due')
      .belowOrEqual(now)
      .filter((r) => r.skill === 'listening' && r.state !== 'unseen' && isActiveCard(r))
      .limit(limit)
      .toArray();
    return rows.map(stripPk);
  }

  /** Phase 20: every card of one item (all skills). */
  async cardsOfItem(item: ItemRef): Promise<SkillCard[]> {
    const skills: Skill[] = ['recognition', 'production', 'listening'];
    const rows = await this.db.items.bulkGet(skills.map((s) => itemPk(item, s)));
    return rows.filter((r): r is NonNullable<typeof r> => !!r).map(stripPk);
  }

  async allCards(): Promise<SkillCard[]> {
    return (await this.db.items.toArray()).map(stripPk);
  }

}
