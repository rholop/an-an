import {
  DEFAULT_REWARD_CONFIG,
  DEFAULT_STREAK_CONFIG,
  makeReward,
  rewardsForEvidence,
  type Evidence,
  type RewardConfig,
  type RewardEvent,
  type SkillCard,
  type StreakConfig,
} from '@anan/core';
import type { AnanDB, ConversationRow, RewardRow } from '../db/schema.js';

const STREAK_KEY = 'streakConfig';
const RETENTION_KEY = 'targetRetention';

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

  async award(events: RewardEvent[]): Promise<void> {
    if (events.length > 0) await this.db.rewardEvents.bulkPut(events);
  }

  /** Wired into LearnerService: successful recalls (+ revived overdue words). */
  async onEvidence(evidence: Evidence, prior: SkillCard | undefined): Promise<void> {
    await this.award(rewardsForEvidence(evidence, prior, this.config));
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
  async onErrorFixed(errorItemId: string, at: Date): Promise<void> {
    await this.award([makeReward('error_fixed', at, errorItemId, this.config)]);
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

  async getTargetRetention(fallback = 0.9): Promise<number> {
    const row = await this.db.settings.get(RETENTION_KEY);
    return typeof row?.value === 'number' ? row.value : fallback;
  }
}
