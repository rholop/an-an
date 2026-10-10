import {
  DEFAULT_REWARD_CONFIG,
  DEFAULT_STREAK_CONFIG,
  makeReward,
  revokeReward,
  rewardsForEvidence,
  type Evidence,
  type RewardConfig,
  type RewardEvent,
  type SkillCard,
  type StreakConfig,
} from '@anan/core';
import type { AnanDB, ConversationRow, RewardRow } from '../db/schema.js';

const STREAK_KEY = 'streakConfig';

/**
 * Phase 6 §1 persistence + hooks. Every award goes through RewardEvent ids
 * from core (kind + ref + local day), so replays and double-fires can't pay
 * twice, and nothing here awards for time spent or opening the app.
 */
export class GameService {
  constructor(
    private readonly db: AnanDB,
    private readonly config: RewardConfig = DEFAULT_REWARD_CONFIG,
  ) {}

  /** Writes the events not already in the ledger; returns those (what this call actually paid). */
  async award(events: RewardEvent[]): Promise<RewardEvent[]> {
    if (events.length === 0) return [];
    const existing = await this.db.rewardEvents.bulkGet(events.map((e) => e.id));
    const fresh = events.filter((_, i) => !existing[i]);
    if (fresh.length > 0) await this.db.rewardEvents.bulkPut(fresh);
    // Phase 32: a reward (a finished journal entry, a completed scenario…) makes its day active.
    const paid = fresh.find((e) => !e.revokes);
    if (paid) await this.db.markActiveDay(paid.at);
    return fresh;
  }

  /** Wired into LearnerService: successful recalls (+ revived overdue words). Returns what was paid. */
  async onEvidence(evidence: Evidence, prior: SkillCard | undefined): Promise<RewardEvent[]> {
    return this.award(rewardsForEvidence(evidence, prior, this.config));
  }

  /** Phase 21 Undo: takes back what an answer paid (append-only, so sync keeps the undo). */
  async revoke(paid: unknown, at: Date): Promise<void> {
    if (!Array.isArray(paid) || paid.length === 0) return;
    await this.db.rewardEvents.bulkPut((paid as RewardEvent[]).map((e) => revokeReward(e, at)));
  }

  /** Scenario completed; the unassisted bonus needs no "I'm stuck" and no English fallback. */
  async onScenarioCompleted(conv: ConversationRow): Promise<void> {
    const at = conv.endedAt ?? new Date();
    const ref = `conversation:${conv.id}`;
    const events = [makeReward('scenario_completed', at, ref, this.config)];
    if (conv.stuckCount === 0 && !conv.englishFallbackUsed)
      events.push(makeReward('scenario_unassisted', at, ref, this.config));
    await this.award(events);
  }

  /** A journal entry finished (+ one reward per issue the learner fixed themselves). */
  async onJournalFinished(
    entryId: string,
    selfFixedIssueIndexes: number[],
    at: Date,
  ): Promise<void> {
    await this.award([
      makeReward('journal_entry', at, entryId, this.config),
      ...selfFixedIssueIndexes.map((i) =>
        makeReward('self_correction', at, `${entryId}:${i}`, this.config),
      ),
    ]);
  }

  /** An error-bank sentence answered correctly. */
  async onErrorFixed(errorItemId: string, at: Date): Promise<RewardEvent[]> {
    return this.award([makeReward('error_fixed', at, errorItemId, this.config)]);
  }

  allRewards(): Promise<RewardRow[]> {
    return this.db.rewardEvents.orderBy('at').toArray();
  }

  async getStreakConfig(): Promise<StreakConfig> {
    const row = await this.db.settings.get(STREAK_KEY);
    return { ...DEFAULT_STREAK_CONFIG, ...(row?.value as Partial<StreakConfig> | undefined) };
  }

  async setStreakConfig(config: StreakConfig): Promise<void> {
    await this.db.settings.put({ key: STREAK_KEY, value: config });
  }
}
