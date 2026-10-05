import Dexie, { type EntityTable } from 'dexie';
import type {
  ErrorItem,
  Evidence,
  ItemRef,
  JournalIssue,
  Level,
  SelfFixRecord,
  SentenceBankEntry,
  Skill,
  SkillCard,
  TurnToken,
  UsedWell,
  Word,
} from '@anan/core';

/** Schema version for export/import compatibility checks — bump whenever a
 * Dexie `.version()` changes the stored shape in a way old backups can't
 * satisfy. Independent of the lexicon version (data/build/lexicon.v*.json). */
export const DB_SCHEMA_VERSION = 6;

export function itemPk(item: ItemRef, skill: Skill): string {
  return `${item.kind}:${item.id}:${skill}`;
}

/** Dexie row shape for the `items` table: a SkillCard plus its primary key.
 * `card.due`/`card.state` etc. stay nested (plain objects survive structured
 * clone fine) so Dexie can index into them with dot-path indexes. */
export interface ItemRow extends SkillCard {
  pk: string;
}

/** Phase 8: every record that can be merged between devices has a globally
 * unique `uid` (rows keyed by an auto-increment number are only unique per
 * browser) and, if it can change in place, an `updatedAt` (set automatically by
 * the table hooks in AnanDB — callers never stamp it by hand). */
export interface EvidenceRow extends Evidence {
  id?: number;
  uid?: string;
}

export interface SettingsRow {
  key: string;
  value: unknown;
  updatedAt?: Date;
}

export interface MetaRow {
  key: string;
  value: unknown;
  updatedAt?: Date;
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
  uid?: string;
  updatedAt?: Date;
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
  uid?: string;
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
  updatedAt?: Date;
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
  updatedAt?: Date;
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
  uid?: string;
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

/** Phase 9: a sentence the reader generated live (POST /v1/sentences) and that
 * passed validation. Kept per profile so the bank grows and repeat presses get
 * cheaper; merged between devices by union. */
export type LiveSentenceRow = SentenceBankEntry & { source: 'generated-live'; createdAt: Date };

/** Phase 9: when the reader last showed a sentence to this profile (for "not
 * the same sentence within 7 days"). One row per sentence id; the later `at` wins. */
export interface ReaderShownRow {
  sentenceId: string;
  at: Date;
  updatedAt?: Date;
}

export type CustomWordRow = Word & { updatedAt?: Date };
export type ErrorItemRow = ErrorItem & { updatedAt?: Date };

/** Tables whose rows change in place (so need `updatedAt` for last-writer-wins). */
const STAMPED_TABLES = [
  'settings',
  'meta',
  'customWords',
  'journalEntries',
  'journalReviews',
  'errorItems',
  'conversations',
  'readerShown',
] as const;
/** The stamped tables AS OF schema v5. The v5 upgrade must only touch tables
 * that exist at v5, so it uses this frozen list — never the live
 * STAMPED_TABLES, which grows as later versions add tables. */
const V5_STAMPED_TABLES = [
  'settings',
  'meta',
  'customWords',
  'journalEntries',
  'journalReviews',
  'errorItems',
  'conversations',
] as const;
/** Tables keyed by a per-browser number that need a global `uid`. */
const UID_TABLES = ['evidence', 'conversations', 'turns', 'glossReports'] as const;
/** Every table, for local-change notifications. */
const ALL_TABLES = [
  'items',
  'evidence',
  'settings',
  'meta',
  'customWords',
  'conversations',
  'turns',
  'journalEntries',
  'journalReviews',
  'errorItems',
  'rewardEvents',
  'glossReports',
  'aiGlosses',
  'liveSentences',
  'readerShown',
] as const;

const newUid = (): string => globalThis.crypto.randomUUID();

export class AnanDB extends Dexie {
  items!: EntityTable<ItemRow, 'pk'>;
  evidence!: EntityTable<EvidenceRow, 'id'>;
  settings!: EntityTable<SettingsRow, 'key'>;
  meta!: EntityTable<MetaRow, 'key'>;
  /** User-added words (source: 'custom'), e.g. from Anki rows that didn't
   * match the built lexicon — merged into the Lexicon at load time
   * (apps/web/src/lib/useLexicon.ts), not part of data/build/lexicon*.json. */
  customWords!: EntityTable<CustomWordRow, 'id'>;
  /** Phase 3: chat history. Phase 4 builds cloze from `turns`. */
  conversations!: EntityTable<ConversationRow, 'id'>;
  turns!: EntityTable<TurnRow, 'id'>;
  /** Phase 5: journal. */
  journalEntries!: EntityTable<JournalEntryRow, 'id'>;
  journalReviews!: EntityTable<JournalReviewRow, 'entryId'>;
  errorItems!: EntityTable<ErrorItemRow, 'id'>;
  /** Phase 6: points ledger. */
  rewardEvents!: EntityTable<RewardRow, 'id'>;
  glossReports!: EntityTable<GlossReportRow, 'id'>;
  aiGlosses!: EntityTable<AiGlossRow, 'key'>;
  /** Phase 9: reader sentences. */
  liveSentences!: EntityTable<LiveSentenceRow, 'id'>;
  readerShown!: EntityTable<ReaderShownRow, 'sentenceId'>;

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
    // v5 (Phase 8): every merge-able record gets a global `uid` and, if it
    // changes in place, an `updatedAt`. Existing rows are backfilled.
    this.version(5)
      .stores({
        evidence: '++id, at, [item.id], kind, uid',
        conversations: '++id, scenarioId, startedAt, uid',
        turns: '++id, conversationId, at, uid',
        glossReports: '++id, wordId, at, uid',
      })
      .upgrade(async (tx) => {
        const epoch = new Date(0);
        for (const name of UID_TABLES) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: { uid?: string }) => {
              row.uid ??= newUid();
            });
        }
        const stampFrom = (row: Record<string, unknown>): Date =>
          (row.finishedAt ??
            row.endedAt ??
            row.createdAt ??
            row.startedAt ??
            row.at ??
            epoch) as Date;
        for (const name of V5_STAMPED_TABLES) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.updatedAt ??= stampFrom(row);
            });
        }
      });
    // v6 (Phase 9): reader sentence tables. Purely additive, so the upgrade has
    // no rows to rewrite — it only records when the reader was first available.
    this.version(6)
      .stores({
        liveSentences: 'id, targetWordId, createdAt',
        readerShown: 'sentenceId, at',
      })
      .upgrade(async (tx) => {
        await tx.table('meta').put({ key: 'readerEnabledAt', value: new Date() });
      });

    // v7 (Phase 16): every journal cloze item is checked before it can be
    // shown. Items that exist already have not been checked, so they wait as
    // `pending_check` (hidden) until the check passes or blocks them. No
    // index changes: `status` is only ever filtered in memory.
    this.version(7)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table('errorItems')
          .toCollection()
          .modify((row: { status?: string }) => {
            row.status ??= 'pending_check';
          });
      });

    this.installHooks();
  }

  /** Called after a LOCAL write (never while a sync merge is writing). */
  onLocalChange?: () => void;
  private suppressed = 0;

  /**
   * Run `fn` while the table hooks are off — used when a sync merge or an
   * import writes records that already carry their own uid/updatedAt, which
   * must be stored exactly as given (and must not count as a local edit).
   */
  async withoutHooks<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressed++;
    try {
      return await fn();
    } finally {
      this.suppressed--;
    }
  }

  private installHooks(): void {
    const notify = () => {
      if (this.suppressed === 0) this.onLocalChange?.();
    };
    for (const name of ALL_TABLES) {
      const table = this.table(name);
      const stamped = (STAMPED_TABLES as readonly string[]).includes(name);
      const hasUid = (UID_TABLES as readonly string[]).includes(name);
      table.hook('creating', (_key, obj: Record<string, unknown>) => {
        if (this.suppressed === 0) {
          if (hasUid) obj.uid ??= newUid();
          if (stamped) obj.updatedAt ??= new Date();
        }
        notify();
      });
      table.hook('updating', () => {
        notify();
        return this.suppressed === 0 && stamped ? { updatedAt: new Date() } : undefined;
      });
      table.hook('deleting', () => {
        notify();
      });
    }
  }
}
