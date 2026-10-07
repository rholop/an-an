import {
  EditKindSchema,
  LevelSchema,
  SentenceTokenSchema,
  type RawSentenceReview,
  type VerifiedSentenceRef,
} from '@anan/core';
import { z } from 'zod';

const ItemRefSchema = z.object({ kind: z.enum(['word', 'grammar']), id: z.string() });
const SkillSchema = z.enum(['recognition', 'production', 'listening']);
const ItemStateSchema = z.enum(['unseen', 'introduced', 'learning', 'review', 'mature']);
const LeechTreatmentSchema = z.enum([
  'new_context',
  'char_breakdown',
  'mnemonic_prompt',
  'contrast_confusable',
]);

const FsrsCardSchema = z.object({
  due: z.coerce.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number(),
  lapses: z.number(),
  state: z.number().int().min(0).max(3),
  last_review: z.coerce.date().optional(),
});

export const SkillCardSchema = z.object({
  item: ItemRefSchema,
  skill: SkillSchema,
  card: FsrsCardSchema,
  state: ItemStateSchema,
  lapses: z.number(),
  leech: z.boolean(),
  leechTreatmentsTried: z.array(LeechTreatmentSchema),
  // Phase 4 additions — defaulted so a backup exported before Phase 4 still
  // imports cleanly (same schemaVersion, no version bump needed for a
  // purely additive field; see CLAUDE.md's Dexie-bump guidance, which is
  // about index/store shape, not every new field).
  clozeRung: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  clozeStreak: z.number().default(0),
  familiarity: z.number(),
  readingDependence: z.number(),
  flags: z.object({
    imported: z.boolean().optional(),
    probablyKnown: z.boolean().optional(),
    priority: z.boolean().optional(),
  }),
  updatedAt: z.coerce.date(),
});

const EvidenceKindSchema = z.enum([
  'cloze_correct_nohint',
  'cloze_correct_hint',
  'cloze_wrong',
  'journal_correct_use',
  'journal_misuse',
  'chat_read_no_lookup',
  'chat_lookup_gloss',
  'chat_hover_reading',
  'review_again',
  'review_hard',
  'review_good',
  'review_easy',
  'anki_import_seen',
  'placement_known',
  'placement_unknown',
  'textbook_lesson_covered',
  'listening_correct',
  'listening_correct_replayed',
  'listening_wrong',
]);

export const EvidenceSchema = z.object({
  uid: z.string().optional(),
  item: ItemRefSchema,
  skill: SkillSchema,
  kind: EvidenceKindSchema,
  at: z.coerce.date(),
  context: z
    .object({
      source: z.enum(['chat', 'journal', 'cloze', 'review', 'placement', 'reader', 'textbook']),
      refId: z.string().optional(),
      selfFixed: z.boolean().optional(),
    })
    .optional(),
});

const WordSchema = z.object({
  id: z.string(),
  headword: z.string(),
  variants: z.array(z.string()),
  pos: z.array(z.string()),
  level: LevelSchema.nullable(),
  source: z.enum(['tocfl', 'supplement', 'custom', 'textbook']),
  pinyin: z.string(),
  pinyinNumeric: z.string(),
  zhuyin: z.string(),
  glossEn: z.string(),
  senseNote: z.string().optional(),
  chars: z.array(z.string()),
  tags: z.array(z.string()),
  freqRank: z.number().optional(),
  updatedAt: z.coerce.date().optional(),
});

const SpanSchema = z.tuple([z.number().int(), z.number().int()]);

const JournalIssueSchema = z.object({
  span: SpanSchema,
  type: z.enum(['error', 'unnatural', 'mainland_style']),
  pattern: z.string().optional(),
  itemRef: ItemRefSchema.optional(),
  correction: z.string(),
  explanationEn: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const JournalEntryRowSchema = z.object({
  updatedAt: z.coerce.date().optional(),
  id: z.string(),
  text: z.string(),
  promptId: z.string().optional(),
  promptWordIds: z.array(z.string()),
  createdAt: z.coerce.date(),
  status: z.enum(['self_correcting', 'revealed', 'finished']),
  finishedAt: z.coerce.date().optional(),
});

export const JournalReviewRowSchema = z.object({
  updatedAt: z.coerce.date().optional(),
  entryId: z.string(),
  learnerLevel: LevelSchema,
  issues: z.array(JournalIssueSchema),
  naturalRewrite: z.string(),
  brackets: z.array(
    z.object({
      en: z.string(),
      zh: z.string(),
      wordId: z.string().optional(),
      source: z.enum(['lexicon', 'llm', 'unresolved']),
    }),
  ),
  usedWell: z.array(z.object({ itemRef: ItemRefSchema, span: SpanSchema })),
  rejectedCount: z.number(),
  // JSON-safe numeric keys: Dexie/structured clone keep them as strings.
  selfFix: z.record(
    z.string(),
    z.object({
      attempt: z.string(),
      fixed: z.boolean(),
      alternative: z.boolean().optional(),
      note: z.string().optional(),
    }),
  ),
  flagged: z.array(z.number()),
  explainMore: z.record(
    z.string(),
    z.object({
      explanationEn: z.string(),
      examples: z.array(z.object({ zh: z.string(), en: z.string() })),
    }),
  ),
  levelHeadline: z.string(),
  wordsUsed: z.array(z.string()),
  errorsPer100Chars: z.number().nullable(),
  createdAt: z.coerce.date(),
  // Phase 17: stored sentence reviews; shaped by core, passed through here.
  sentences: z.array(z.custom<RawSentenceReview>()).optional(),
  verifiedSentences: z
    .array(
      z
        .custom<VerifiedSentenceRef>()
        .transform((v) => ({ ...v, checkedAt: new Date(v.checkedAt as unknown as string) })),
    )
    .optional(),
  itemsBuiltAt: z.coerce.date().optional(),
});

export const ErrorItemSchema = z.object({
  updatedAt: z.coerce.date().optional(),
  id: z.string(),
  journalEntryId: z.string(),
  original: z.string(),
  corrected: z.string(),
  span: SpanSchema,
  type: z.enum(['error', 'unnatural', 'mainland_style']),
  pattern: z.string().optional(),
  itemRef: ItemRefSchema.optional(),
  card: FsrsCardSchema,
  flagged: z.boolean(),
  createdAt: z.coerce.date(),
  // Phase 16
  status: z
    .enum(['active', 'pending_check', 'blocked', 'reported', 'deleted', 'pending_rebuild'])
    .optional(),
  blockedReason: z.string().optional(),
  report: z
    .object({
      reason: z.enum([
        'garbled',
        'wrong_answer',
        'other_answer_fits',
        'blank_misplaced',
        'english_wrong',
        'other',
      ]),
      note: z.string().optional(),
      reportedAt: z.coerce.date(),
      profileId: z.string(),
    })
    .optional(),
  blank: SpanSchema.optional(),
  // Phase 17
  version: z.literal(2).optional(),
  en: z.string().optional(),
  explanationEn: z.string().optional(),
  editKind: EditKindSchema.optional(),
  marks: z.object({ original: z.array(SpanSchema), corrected: z.array(SpanSchema) }).optional(),
  exercise: z.any().optional(),
});

export const ConversationRowSchema = z.object({
  uid: z.string().optional(),
  updatedAt: z.coerce.date().optional(),
  id: z.number().optional(),
  scenarioId: z.string(),
  npcId: z.string(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  goalStepsDone: z.array(z.string()),
  completed: z.boolean().default(false),
  stuckCount: z.number().default(0),
  englishFallbackUsed: z.boolean().default(false),
  kind: z.literal('open').optional(),
  topic: z.string().optional(),
  summary: z.string().optional(),
  summarizedUpTo: z.number().optional(),
});

export const TurnRowSchema = z.object({
  uid: z.string().optional(),
  id: z.number().optional(),
  conversationId: z.number(),
  role: z.enum(['npc', 'learner']),
  zh: z.string(),
  en: z.string().optional(),
  tokens: z.array(z.object({ text: z.string(), lemma: z.string().optional() })).optional(),
  suggestedReplies: z.array(z.object({ zh: z.string(), en: z.string() })).optional(),
  recastZh: z.string().optional(),
  validatorReport: z
    .object({
      coverage: z.number(),
      maxLevel: LevelSchema.nullable(),
      unknownCount: z.number(),
      attempts: z.number(),
      pass: z.boolean(),
      tiers: z
        .object({
          a: z.number(),
          b: z.number(),
          c: z.number(),
          allowed: z.number(),
          shareA: z.number(),
          usesUpcoming: z.boolean(),
          bIds: z.array(z.string()),
          cIds: z.array(z.string()),
          upcomingIds: z.array(z.string()),
        })
        .optional(),
    })
    .optional(),
  glosses: z.array(z.object({ text: z.string(), gloss: z.string() })).optional(),
  at: z.coerce.date(),
});

export const RewardRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  points: z.number(),
  at: z.coerce.date(),
  refId: z.string().optional(),
});

export const GlossReportRowSchema = z.object({
  uid: z.string().optional(),
  id: z.number().optional(),
  wordId: z.string(),
  headword: z.string(),
  pinyin: z.string(),
  senseId: z.string().optional(),
  shownGloss: z.string(),
  contextSentence: z.string(),
  note: z.string().optional(),
  at: z.coerce.date(),
});

export const AiGlossRowSchema = z.object({
  key: z.string(),
  word: z.string(),
  pinyin: z.string(),
  glossEn: z.string(),
  noteEn: z.string().optional(),
  contextSentence: z.string().optional(),
  at: z.coerce.date(),
});

export const LiveSentenceRowSchema = z.object({
  id: z.string(),
  zh: z.string(),
  en: z.string(),
  targetWordId: z.string(),
  level: LevelSchema,
  tokens: z.array(SentenceTokenSchema),
  source: z.literal('generated-live'),
  doubtful: z.boolean().default(false),
  createdAt: z.coerce.date(),
});

export const ReaderShownRowSchema = z.object({
  sentenceId: z.string(),
  at: z.coerce.date(),
  updatedAt: z.coerce.date().optional(),
});

export const BackupSchema = z.object({
  schemaVersion: z.number().int(),
  lexiconVersion: z.string().optional(),
  exportedAt: z.string(),
  items: z.array(SkillCardSchema),
  evidence: z.array(EvidenceSchema),
  settings: z.record(z.string(), z.unknown()),
  meta: z.record(z.string(), z.unknown()),
  customWords: z.array(WordSchema).default([]),
  // Phase 5 (schemaVersion 2). Defaulted so v1 backups still import.
  journalEntries: z.array(JournalEntryRowSchema).default([]),
  journalReviews: z.array(JournalReviewRowSchema).default([]),
  errorItems: z.array(ErrorItemSchema).default([]),
  // Phase 6 (schemaVersion 3). Conversations/turns were not backed up before,
  // so scenario stars would have been lost on restore.
  conversations: z.array(ConversationRowSchema).default([]),
  turns: z.array(TurnRowSchema).default([]),
  rewardEvents: z.array(RewardRowSchema).default([]),
  // Phase 7 (schemaVersion 4).
  glossReports: z.array(GlossReportRowSchema).default([]),
  aiGlosses: z.array(AiGlossRowSchema).default([]),
  // Phase 9 (schemaVersion 6): reader sentences.
  liveSentences: z.array(LiveSentenceRowSchema).default([]),
  readerShown: z.array(ReaderShownRowSchema).default([]),
  // Phase 8 (schemaVersion 5): when each settings/meta key last changed, so
  // two devices can keep the later edit. Absent in older backups.
  settingsUpdatedAt: z.record(z.string(), z.coerce.date()).default({}),
  metaUpdatedAt: z.record(z.string(), z.coerce.date()).default({}),
});

export type Backup = z.infer<typeof BackupSchema>;
