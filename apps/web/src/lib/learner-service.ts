import {
  applyEvidence,
  buildFsrs,
  DEFAULT_LEARNER_CONFIG,
  type Evidence,
  type FSRS,
  type ItemState,
  type LearnerConfig,
  type LearnerRepo,
  type SkillCard,
} from '@anan/core';

interface UndoableRepo {
  appendEvidenceKeys(events: Evidence[]): Promise<number[]>;
  undoEvidence(
    evidenceId: number,
    item: Evidence['item'],
    skill: Evidence['skill'],
    prior: SkillCard | undefined,
  ): Promise<void>;
}

/**
 * Thin orchestration layer around the pure `applyEvidence` + a `LearnerRepo`:
 * fetch the current card, apply one evidence event, persist the result and
 * append to the evidence log. This is the one place in apps/web that's
 * allowed to call `new Date()` — every other caller passes `now` through.
 */
export class LearnerService {
  private readonly fsrsInstance: FSRS;

  constructor(
    private readonly repo: LearnerRepo,
    private readonly config: LearnerConfig = DEFAULT_LEARNER_CONFIG,
    /** Phase 6: told about every single recorded piece of evidence, with the
     * card as it was *before* (e.g. to award points). Failures never block
     * learning. */
    private readonly onRecorded?: (
      evidence: Evidence,
      prior: SkillCard | undefined,
    ) => Promise<void>,
  ) {
    this.fsrsInstance = buildFsrs(config);
  }

  async record(evidence: Evidence, now: Date = new Date()): Promise<SkillCard | undefined> {
    const current = await this.repo.getCard(evidence.item, evidence.skill);
    const result = applyEvidence(current, evidence, now, this.config, this.fsrsInstance);
    if (result.card) await this.repo.putCards([result.card]);
    await this.repo.appendEvidence([evidence]);
    if (this.onRecorded) await this.onRecorded(evidence, current).catch(() => undefined);
    return result.card;
  }

  /** Phase 16: `record`, but keeps what is needed to take it back exactly. A
   * repo without undo support (a test double) records normally and can't undo. */
  async recordUndoable(
    evidence: Evidence,
    now: Date = new Date(),
  ): Promise<{ card: SkillCard | undefined; undo: () => Promise<void> }> {
    const repo = this.repo as Partial<UndoableRepo> & LearnerRepo;
    if (!repo.appendEvidenceKeys || !repo.undoEvidence) {
      return { card: await this.record(evidence, now), undo: async () => undefined };
    }
    const prior = await repo.getCard(evidence.item, evidence.skill);
    const result = applyEvidence(prior, evidence, now, this.config, this.fsrsInstance);
    if (result.card) await repo.putCards([result.card]);
    const [id] = await repo.appendEvidenceKeys([evidence]);
    if (this.onRecorded) await this.onRecorded(evidence, prior).catch(() => undefined);
    return {
      card: result.card,
      undo: async () => {
        if (id !== undefined)
          await repo.undoEvidence!(id, evidence.item, evidence.skill, prior);
      },
    };
  }

  /** Same as `record`, batched: one parallel read pass, one bulk write pass
   * — used by Anki import so a few thousand rows doesn't mean a few
   * thousand sequential round-trips. */
  async recordBulk(events: Evidence[], now: Date = new Date()): Promise<SkillCard[]> {
    const currents = await Promise.all(events.map((e) => this.repo.getCard(e.item, e.skill)));
    const results = events.map((e, i) =>
      applyEvidence(currents[i], e, now, this.config, this.fsrsInstance),
    );
    const cards = results.map((r) => r.card).filter((c): c is SkillCard => c !== undefined);
    await this.repo.putCards(cards);
    await this.repo.appendEvidence(events);
    return cards;
  }

  /** Writes a card as-is (no evidence) — for flags like Phase 5's `priority`
   * that sit on the card but aren't learner evidence. */
  putCard(card: SkillCard): Promise<void> {
    return this.repo.putCards([card]);
  }

  dueCards(now: Date = new Date(), limit = 50): Promise<SkillCard[]> {
    return this.repo.dueCards(now, limit);
  }

  /** Phase 15: due listening cards (their own queue). */
  dueListeningCards(now: Date = new Date(), limit = 50): Promise<SkillCard[]> {
    return (this.repo as unknown as { dueListeningCards(n: Date, l: number): Promise<SkillCard[]> }).dueListeningCards(now, limit);
  }

  knownSet(minState: ItemState = 'review'): Promise<Set<string>> {
    return this.repo.knownSet(minState);
  }

  getCard(item: Evidence['item'], skill: Evidence['skill']): Promise<SkillCard | undefined> {
    return this.repo.getCard(item, skill);
  }
}
