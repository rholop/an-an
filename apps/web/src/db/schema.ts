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
export const DB_SCHEMA_VERSION = 4;

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
  /** Phase 6 (v3). Every goal step done, as opposed to ended early. */
  completed: boolean;
  /** Phase 6: times "I'm stuck" was pressed. */
  stuckCount: number;
  /** Phase 6: English fallback was on for any learner turn. */
  englishFallbackUsed: boolean;
}

/** Phase 6: the reward ledger. Rows are RewardEvents from core; `id` is
 * deterministic so awarding twice is harmless. */
export interface RewardRow {
  id: string;
  kind: string;
  points: number;
  at: Date;
  refId?: string;
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

/** Phase 7 §B6: a learner's "Report this definition", kept locally and
 * exported as a list the owner can paste into data/supplement/gloss-overrides.yaml. */
export interface GlossReportRow {
  id?: number;
  wordId: string;
  headword: string;
  pinyin: string;
  senseId?: string;
  shownGloss: string;
  contextSentence: string;
  note?: string;
  at: Date;
}

/** Phase 7 §B5: cached AI definitions for words NOT in the lexicon, labelled
 * "AI-generated" in the UI and queued for human review. */
export interface AiGlossRow {
  key: string;
  word: string;
  pinyin: string;
  glossEn: string;
  noteEn?: string;
  contextSentence?: string;
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
  /** Phase 5: journal. */
  journalEntries!: EntityTable<JournalEntryRow, 'id'>;
  journalReviews!: EntityTable<JournalReviewRow, 'entryId'>;
  errorItems!: EntityTable<ErrorItem, 'id'>;
  /** Phase 6: points ledger. */
  rewardEvents!: EntityTable<RewardRow, 'id'>;
  glossReports!: EntityTable<GlossReportRow, 'id'>;
  aiGlosses!: EntityTable<AiGlossRow, 'key'>;

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
    // v3 (Phase 6): reward ledger + per-conversation game fields. Existing
    // conversations can't be classified retroactively (completion depends on
    // scenario data the upgrade doesn't have), so they get no stars: not
    // completed, but also no "stuck"/English marks.
    this.version(3)
      .stores({ rewardEvents: 'id, at, kind' })
      .upgrade(async (tx) => {
        await tx
          .table('conversations')
          .toCollection()
          .modify((c: Partial<ConversationRow>) => {
            c.completed ??= false;
            c.stuckCount ??= 0;
            c.englishFallbackUsed ??= false;
          });
      });
    // v4 (Phase 7): gloss reports + cached AI definitions. Purely additive.
    this.version(4)
      .stores({ glossReports: '++id, wordId, at', aiGlosses: 'key, at' })
      .upgrade(async (tx) => {
        await tx.table('meta').put({ key: 'glossReportsEnabledAt', value: new Date() });
      });
  }
}
