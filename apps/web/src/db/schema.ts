import Dexie, { type EntityTable } from 'dexie';
import type { Evidence, ItemRef, Level, Skill, SkillCard, TurnToken, Word } from '@anan/core';

/** Schema version for export/import compatibility checks — bump whenever a
 * Dexie `.version()` changes the stored shape in a way old backups can't
 * satisfy. Independent of the lexicon version (data/build/lexicon.v*.json). */
export const DB_SCHEMA_VERSION = 1;

export function itemPk(item: ItemRef, skill: Skill): string {
  return `${item.kind}:${item.id}:${skill}`;
}

/** Dexie row shape for the `items` table: a SkillCard plus its primary key.
 * `card.due`/`card.state` etc. stay nested (plain objects survive structured
 * clone fine) so Dexie can index into them with dot-path indexes. */
export interface ItemRow extends SkillCard {
  pk: string;
}

export interface EvidenceRow extends Evidence {
  id?: number;
}

export interface SettingsRow {
  key: string;
  value: unknown;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export interface ValidatorReportRow {
  coverage: number;
  maxLevel: Level | null;
  unknownCount: number;
  attempts: number;
  pass: boolean;
}

export interface ConversationRow {
  id?: number;
  scenarioId: string;
  npcId: string;
  startedAt: Date;
  endedAt?: Date;
  /** Latest known goal_progress, keyed by step id — updated as turns land. */
  goalStepsDone: string[];
}

export interface TurnRow {
  id?: number;
  conversationId: number;
  role: 'npc' | 'learner';
  zh: string;
  en?: string;
  /** Only populated for npc turns (from TurnResponse.tokens). Phase 4 builds
   * cloze from these. */
  tokens?: TurnToken[];
  /** npc turns only — TurnResponse.suggested_replies, for the chat UI's
   * reply chips and "I'm stuck" model answer (phase doc §7). */
  suggestedReplies?: { zh: string; en: string }[];
  /** npc turns only — TurnResponse.recast_zh, the Chinese recast of the
   * PRECEDING learner turn's English (englishFallback mode). */
  recastZh?: string;
  validatorReport?: ValidatorReportRow;
  at: Date;
}

export class AnanDB extends Dexie {
  items!: EntityTable<ItemRow, 'pk'>;
  evidence!: EntityTable<EvidenceRow, 'id'>;
  settings!: EntityTable<SettingsRow, 'key'>;
  meta!: EntityTable<MetaRow, 'key'>;
  /** User-added words (source: 'custom'), e.g. from Anki rows that didn't
   * match the built lexicon — merged into the Lexicon at load time
   * (apps/web/src/lib/useLexicon.ts), not part of data/build/lexicon*.json. */
  customWords!: EntityTable<Word, 'id'>;
  /** Phase 3: chat history. Phase 4 builds cloze from `turns`. */
  conversations!: EntityTable<ConversationRow, 'id'>;
  turns!: EntityTable<TurnRow, 'id'>;

  constructor(name = 'anan') {
    super(name);
    this.version(1).stores({
      items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
      evidence: '++id, at, [item.id], kind',
      settings: 'key',
      meta: 'key',
      customWords: 'id, headword',
      conversations: '++id, scenarioId, startedAt',
      turns: '++id, conversationId, at',
    });
  }
}
