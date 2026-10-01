import type { ChatLineSource, Scenario, SkillCard } from '@anan/core';
import type { AnanDB } from './schema.js';

/** Count of cards due on each of the next `days` calendar days (today
 * first), for the review screen's forecast. Direct Dexie query — not part
 * of the core LearnerRepo contract, which only needs dueCards()/knownSet(). */
export async function dueForecast(db: AnanDB, now: Date, days = 7): Promise<number[]> {
  const dayStart = (offset: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
  };

  const counts: number[] = [];
  for (let i = 0; i < days; i++) {
    const from = dayStart(i);
    const to = dayStart(i + 1);
    const count = await db.items.where('card.due').between(from, to, true, false).count();
    counts.push(count);
  }
  return counts;
}

/** All cards ever touched (any state past 'unseen'), for consumers that need
 * the learner's whole history rather than just what's currently due —
 * `currentFrontierLevel()` and pinyin fading's per-word `readingDisplay()`
 * both need this, and neither fits the `LearnerRepo.dueCards()`/`knownSet()`
 * contract (which is deliberately narrow — see Phase 2). Not part of
 * LearnerRepo for the same reason dueForecast isn't: a direct Dexie
 * convenience, not a cross-storage-backend API. */
export async function allTouchedCards(db: AnanDB): Promise<SkillCard[]> {
  const rows = await db.items.where('state').notEqual('unseen').toArray();
  return rows.map(({ pk: _pk, ...card }) => card);
}

export async function recognitionCardsByWordId(db: AnanDB): Promise<Map<string, SkillCard>> {
  const cards = await allTouchedCards(db);
  const map = new Map<string, SkillCard>();
  for (const card of cards) {
    if (card.skill === 'recognition') map.set(card.item.id, card);
  }
  return map;
}

/** Every chat turn ever recorded, shaped for core's selectClozeSource()
 * (phase doc 04 §2's "an NPC or learner line from chat history containing
 * the word"). `scenarios` supplies the title/NPC name a conversation row
 * only references by id — not stored in Dexie since scenario data is a
 * static fetched asset, not learner-owned state (see useScenarios.ts). */
export async function allChatLines(db: AnanDB, scenarios: Scenario[]): Promise<ChatLineSource[]> {
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const [turns, conversations] = await Promise.all([db.turns.toArray(), db.conversations.toArray()]);
  const conversationById = new Map(conversations.map((c) => [c.id!, c]));

  const lines: ChatLineSource[] = [];
  for (const turn of turns) {
    const conv = conversationById.get(turn.conversationId);
    const scenario = conv ? scenarioById.get(conv.scenarioId) : undefined;
    lines.push({
      zh: turn.zh,
      role: turn.role,
      scenarioTitle: scenario?.title ?? conv?.scenarioId ?? 'a past conversation',
      npcName: scenario?.npc.name,
      at: turn.at,
    });
  }
  return lines;
}
