import Dexie, { type EntityTable } from 'dexie';
import type {
  ErrorItem,
  Evidence,
  ItemRef,
  JournalIssue,
  Level,
  SelfFixRecord,
  Skill,
  SkillCard,
  TurnToken,
  UsedWell,
  Word,
} from '@anan/core';

/** Schema version for export/import compatibility checks — bump whenever a
 * Dexie `.version()` changes the stored shape in a way old backups can't
 * satisfy. Independent of the lexicon version (data/build/lexicon.v*.json). */
export const DB_SCHEMA_VERSION = 2;

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

/** Phase 5. Ids are random uuid strings (CLAUDE.md: ids are stable strings,
 * never row numbers). */
export interface JournalEntryRow {
  id: string;
  text: string;
  /** The daily prompt this entry answered (WritingPrompt.id), if any. */
  promptId?: string;
  /** Lexicon ids of the "try to use these" words shown with the prompt. */
  promptWordIds: string[];
  createdAt: Date;
  /** self_correcting: highlights shown, answers hidden. revealed: corrections
   * visible, flags/explain-more available. finished: evidence + error bank
   * written; the entry is closed. */
  status: 'self_correcting' | 'revealed' | 'finished';
  finishedAt?: Date;
}

export interface ResolvedBracket {
  en: string;
  zh: string;
  wordId?: string;
  /** 'lexicon' wins over 'llm' (phase doc §2); 'unresolved' means neither knew. */
  source: 'lexicon' | 'llm' | 'unresolved';
}

export interface JournalReviewRow {
  /** Same as the entry's id — one review per entry. */
  entryId: string;
  learnerLevel: Level;
  /** Validated and capped (never more than 3). Index = issue number used by
   * selfFix / flagged / explainMore. */
  issues: JournalIssue[];
  naturalRewrite: string;
  brackets: ResolvedBracket[];
  usedWell: UsedWell[];
  /** How many raw model items validation threw away (dev metric). */
  rejectedCount: number;
  selfFix: Record<number, SelfFixRecord>;
  /** Issue indices the learner flagged as wrong (dev metric + excluded from
   * the error bank). */
  flagged: number[];
  explainMore: Record<number, { explanationEn: string; examples: { zh: string; en: string }[] }>;
  levelHeadline: string;
  wordsUsed: string[];
  /** Updated when the entry is finished (flagged issues don't count). */
  errorsPer100Chars: number | null;
  createdAt: Date;
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
  /** Phase 5: journal. */
  journalEntries!: EntityTable<JournalEntryRow, 'id'>;
  journalReviews!: EntityTable<JournalReviewRow, 'entryId'>;
  errorItems!: EntityTable<ErrorItem, 'id'>;

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
    // v2 (Phase 5): journal tables. Purely additive, so the upgrade has no
    // rows to rewrite — it just records when journal mode was first enabled.
    this.version(2)
      .stores({
        journalEntries: 'id, createdAt, status',
        journalReviews: 'entryId, createdAt',
        errorItems: 'id, journalEntryId, card.due, pattern',
      })
      .upgrade(async (tx) => {
        await tx.table('meta').put({ key: 'journalEnabledAt', value: new Date() });
      });
  }
}
