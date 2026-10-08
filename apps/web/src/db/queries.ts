import {
  clozeSourceSentences,
  type ChatLineSource,
  type JournalSentenceSource,
  type Scenario,
  type SkillCard,
} from '@anan/core';
import type { AnanDB } from './schema.js';

/** All cards ever touched (any state past 'unseen'), for consumers that need
 * the learner's whole history rather than just what's currently due —
 * `currentFrontierLevel()` and pinyin fading's per-word `readingDisplay()`
 * both need this, and neither fits the `LearnerRepo.dueCards()`/`knownSet()`
 * contract (which is deliberately narrow — see Phase 2). Not part of
 * LearnerRepo: a direct Dexie
 * convenience, not a cross-storage-backend API. */
export async function allTouchedCards(db: AnanDB): Promise<SkillCard[]> {
  const rows = await db.items.where('state').notEqual('unseen').toArray();
  // Phase 15: listening cards are a separate queue (see `allListeningCards`).
  return rows.filter((r) => r.skill !== 'listening').map(({ pk: _pk, ...card }) => card);
}

export async function allListeningCards(db: AnanDB): Promise<SkillCard[]> {
  const rows = await db.items.filter((r) => r.skill === 'listening').toArray();
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
  const [turns, conversations] = await Promise.all([
    db.turns.toArray(),
    db.conversations.toArray(),
  ]);
  const conversationById = new Map(conversations.map((c) => [c.id!, c]));

  const lines: ChatLineSource[] = [];
  for (const turn of turns) {
    const conv = conversationById.get(turn.conversationId);
    const scenario = conv ? scenarioById.get(conv.scenarioId) : undefined;
    lines.push({
      zh: turn.zh,
      en: turn.en,
      role: turn.role,
      scenarioTitle:
        conv?.kind === 'open' ? 'Open chat' : (scenario?.title ?? conv?.scenarioId ?? 'a past conversation'),
      npcName: conv?.kind === 'open' ? '安安' : scenario?.npc.name,
      at: turn.at,
    });
  }
  return lines;
}

/** Phase 5 §9, rebuilt in Phase 17 Part E: the learner's own journal sentences
 * as a plain cloze source. Only sentences that passed Part B are offered: a
 * sentence with no edits as written, or the verified corrected version of one
 * that had edits. A sentence under a flagged correction, or one the learner
 * reported, is never offered. Entries not yet processed contribute nothing. */
export async function allJournalSentences(
  db: AnanDB,
  excluded: ReadonlySet<string> = new Set(),
): Promise<JournalSentenceSource[]> {
  const [entries, reviews] = await Promise.all([db.journalEntries.toArray(), db.journalReviews.toArray()]);
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const out: JournalSentenceSource[] = [];
  for (const review of reviews) {
    const entry = entryById.get(review.entryId);
    if (!entry || entry.status !== 'finished') continue;
    const flagged = review.flagged.flatMap((i) => (review.issues[i] ? [review.issues[i]!.span] : []));
    const usable = (review.verifiedSentences ?? []).filter(
      (v) => !flagged.some(([a, b]) => a < v.end && v.start < b),
    );
    for (const s of clozeSourceSentences(usable))
      if (!excluded.has(s.zh)) out.push({ zh: s.zh, at: entry.finishedAt ?? entry.createdAt });
  }
  return out;
}
