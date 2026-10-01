import { z } from 'zod';

const ItemRefSchema = z.object({ kind: z.enum(['word', 'grammar']), id: z.string() });
const SkillSchema = z.enum(['recognition', 'production']);
const ItemStateSchema = z.enum(['unseen', 'introduced', 'learning', 'review', 'mature']);
const LeechTreatmentSchema = z.enum(['new_context', 'char_breakdown', 'mnemonic_prompt', 'contrast_confusable']);

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
  familiarity: z.number(),
  readingDependence: z.number(),
  flags: z.object({ imported: z.boolean().optional(), probablyKnown: z.boolean().optional() }),
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
]);

export const EvidenceSchema = z.object({
  item: ItemRefSchema,
  skill: SkillSchema,
  kind: EvidenceKindSchema,
  at: z.coerce.date(),
  context: z
    .object({
      source: z.enum(['chat', 'journal', 'cloze', 'review', 'placement']),
      refId: z.string().optional(),
    })
    .optional(),
});

const WordSchema = z.object({
  id: z.string(),
  headword: z.string(),
  variants: z.array(z.string()),
  pos: z.array(z.string()),
  level: z.enum(['N1', 'N2', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']).nullable(),
  source: z.enum(['tocfl', 'supplement', 'custom']),
  pinyin: z.string(),
  pinyinNumeric: z.string(),
  zhuyin: z.string(),
  glossEn: z.string(),
  senseNote: z.string().optional(),
  chars: z.array(z.string()),
  tags: z.array(z.string()),
  freqRank: z.number().optional(),
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
});

export type Backup = z.infer<typeof BackupSchema>;
