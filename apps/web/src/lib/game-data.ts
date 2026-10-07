import {
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
  type SkillCard,
} from '@anan/core';
import { allTouchedCards } from '../db/queries.js';
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
 * `targetRetention` is the garden's wilt threshold.
 */
export async function loadGameSnapshot(
  db: AnanDB,
  lexicon: Lexicon,
  scenarios: Scenario[],
  now: Date,
  targetRetention = DEFAULT_LEARNER_CONFIG.requestRetention,
  /** Phase 7: the learner's chosen level; falls back to the derived frontier. */
  chosenLevel?: Level,
): Promise<GameSnapshot> {
  const [cards, conversations, rewards, convRows, turns] = await Promise.all([
    allTouchedCards(db),
    conversationRecords(db),
    db.rewardEvents.orderBy('at').toArray(),
    db.conversations.toArray(),
    db.turns.toArray(),
  ]);

  const recognition = cards.filter((c) => c.skill === 'recognition');
  const frontier = chosenLevel ?? currentFrontierLevel(lexicon.allWords(), recognition);
  const knownIds = new Set(
    cards.filter((c) => c.state === 'review' || c.state === 'mature').map((c) => c.item.id),
  );
  const learningIds = new Set(cards.filter((c) => c.state === 'learning').map((c) => c.item.id));
  const ctx = coverageContext(lexicon, frontier, knownIds, learningIds);

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

  const fsrs = buildFsrs(DEFAULT_LEARNER_CONFIG);
  const plants = buildPlants(cards, lexicon, now, fsrs, { targetRetention, witheredMargin: 0.2 });
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
