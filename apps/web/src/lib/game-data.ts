import {
  activeRewards,
  buildFsrs,
  buildPlants,
  buildScenarioMap,
  coverageContext,
  currentFrontierLevel,
  DEFAULT_LEARNER_CONFIG,
  groupPlots,
  scenarioCorpus,
  scenarioCoverage,
  type ConversationRecord,
  type Level,
  type Lexicon,
  type Plant,
  type Plot,
  type Scenario,
  type ScenarioCoverage,
  type ScenarioNode,
  ProgressIndex,
  type SkillCard,
  wordSets,
} from '@anan/core';
import { allTouchedCards } from '../db/queries.js';
import { peekStudySettings } from './study.js';
import { readTargetRetention } from './retention.js';
import type { AnanDB, RewardRow } from '../db/schema.js';

export type StoredConversation = ConversationRecord & { learnerTurns: number };

/** Every stored conversation, shaped for core's star/metrics functions. */
export async function conversationRecords(db: AnanDB): Promise<StoredConversation[]> {
  const [conversations, turns] = await Promise.all([
    db.conversations.toArray(),
    db.turns.toArray(),
  ]);
  const learnerTurns = new Map<number, number>();
  for (const t of turns)
    if (t.role === 'learner')
      learnerTurns.set(t.conversationId, (learnerTurns.get(t.conversationId) ?? 0) + 1);
  // Phase 18: open chats have no goals or stars; they never count as scenario attempts.
  return conversations.filter((c) => c.kind !== 'open').map((c) => ({
    scenarioId: c.scenarioId,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    completed: c.completed ?? false,
    stuckCount: c.stuckCount ?? 0,
    englishFallbackUsed: c.englishFallbackUsed ?? false,
    learnerTurns: learnerTurns.get(c.id!) ?? 0,
  }));
}

export interface GameSnapshot {
  frontier: Level;
  cards: SkillCard[];
  nodes: ScenarioNode[];
  coverage: Map<string, ScenarioCoverage>;
  plants: Plant[];
  plots: Plot[];
  conversations: StoredConversation[];
  rewards: RewardRow[];
}

/**
 * Everything the garden, scenario map and progress screens need, computed
 * from local data only (works fully offline — phase doc acceptance).
 * Phase 21: the target retention is the ONE stored setting (the scheduler uses it too), stages
 * and coverage use the shared terms, and undone rewards don't count.
 */
export async function loadGameSnapshot(
  db: AnanDB,
  lexicon: Lexicon,
  scenarios: Scenario[],
  now: Date,
  targetRetention?: number,
  /** Phase 7: the learner's chosen level; falls back to the derived frontier. */
  chosenLevel?: Level,
): Promise<GameSnapshot> {
  const [cards, conversations, rewardRows, convRows, turns, retention] = await Promise.all([
    allTouchedCards(db),
    conversationRecords(db),
    db.rewardEvents.orderBy('at').toArray(),
    db.conversations.toArray(),
    db.turns.toArray(),
    targetRetention === undefined ? readTargetRetention(db) : Promise.resolve(targetRetention),
  ]);
  const rewards = activeRewards(rewardRows) as RewardRow[];

  const recognition = cards.filter((c) => c.skill === 'recognition');
  const frontier = chosenLevel ?? currentFrontierLevel(lexicon.allWords(), recognition);
  // One "comprehensible" definition (the chat validator's): Learned ∪ due ∪ learning ∪ allowed.
  const sets = wordSets(cards, now, { knownItems: peekStudySettings().knownItems });
  const ctx = coverageContext(lexicon, frontier, sets.knownIds, sets.learningIds, sets.dueIds);

  const scenarioByConv = new Map(convRows.map((c) => [c.id!, c.scenarioId]));
  const npcLines = new Map<string, Set<string>>();
  for (const t of turns) {
    if (t.role !== 'npc') continue;
    const sid = scenarioByConv.get(t.conversationId);
    if (!sid) continue;
    const set = npcLines.get(sid) ?? new Set<string>();
    set.add(t.zh);
    npcLines.set(sid, set);
  }
  const coverage = new Map<string, ScenarioCoverage>();
  for (const s of scenarios) {
    coverage.set(s.id, scenarioCoverage(scenarioCorpus(s, [...(npcLines.get(s.id) ?? [])]), ctx));
  }

  const fsrs = buildFsrs({ ...DEFAULT_LEARNER_CONFIG, requestRetention: retention });
  const plants = buildPlants(
    cards,
    lexicon,
    now,
    fsrs,
    { targetRetention: retention, witheredMargin: 0.2 },
    // the same Learned / Mastered as every tab (plants are words, so grammar uses don't matter here)
    new ProgressIndex({ cards, knownItems: peekStudySettings().knownItems }),
  );
  return {
    frontier,
    cards,
    nodes: buildScenarioMap(scenarios, frontier, conversations),
    coverage,
    plants,
    plots: groupPlots(plants, scenarios, lexicon),
    conversations,
    rewards,
  };
}
