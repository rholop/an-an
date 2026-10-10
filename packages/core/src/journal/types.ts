import { z } from 'zod';
import type { Card } from 'ts-fsrs';
import { LevelSchema } from '../chat/level-schema.js';
import type { ItemRef } from '../types.js';

// Phase 5 wire + storage contracts. As with chat/types.ts, the zod schemas
// live in core so apps/proxy (request handling) and apps/web (fetch calls)
// share one source of truth.

export const IssueTypeSchema = z.enum(['error', 'unnatural', 'mainland_style']);
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const IssueConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type IssueConfidence = z.infer<typeof IssueConfidenceSchema>;

export const ItemRefSchema = z.object({ kind: z.enum(['word', 'grammar']), id: z.string() });

/** [start, end) offsets into the learner's original text, as JS string
 * indices (UTF-16 code units — identical to character offsets for the BMP
 * Han range this app deals in). */
export const SpanSchema = z.tuple([z.number().int(), z.number().int()]);
export type Span = z.infer<typeof SpanSchema>;

/** Phase 31 Part A: the "Why?" of one correction, in plain English for the learner's level. */
export const IssueExplanationSchema = z.object({
  /** What's wrong: "念書 already has its object, 書 (book), so it can't take 中文 after it." */
  wrongEn: z.string().min(1).max(400),
  /** The fix and why it works: "念中文 (study Chinese) · 學中文 is the most common way to say it." */
  fixEn: z.string().min(1).max(400),
  /** One wrong → right example pair (Chinese). */
  exampleWrong: z.string().min(1).max(80),
  exampleRight: z.string().min(1).max(80),
  /** For "unnatural": what a native speaker would say, and that the original is understandable. */
  nativeEn: z.string().max(300).optional(),
});
export type IssueExplanation = z.infer<typeof IssueExplanationSchema>;

/** Phase 31 Part A.4: `checked` passed the independent check; `unsure` failed it twice ("We're not
 * sure about this one", never practised); `pending` couldn't be checked yet (retried). Set by code
 * only, never by the model. */
export const ExplainStatusSchema = z.enum(['checked', 'unsure', 'pending']);
export type ExplainStatus = z.infer<typeof ExplainStatusSchema>;

export const JournalIssueSchema = z.object({
  span: SpanSchema,
  type: IssueTypeSchema,
  pattern: z.string().optional(),
  itemRef: ItemRefSchema.optional(),
  correction: z.string(),
  explanationEn: z.string(),
  confidence: IssueConfidenceSchema,
  /** Phase 31: the structured "Why?". */
  explain: IssueExplanationSchema.optional(),
  /** Phase 31 Part C.2: the meaning the corrector assumed for the sentence ("Read as: …"). */
  meaningEn: z.string().max(400).optional(),
  explainStatus: ExplainStatusSchema.optional(),
});
export type JournalIssue = z.infer<typeof JournalIssueSchema>;

export const JournalBracketSchema = z.object({
  en: z.string(),
  zh: z.string(),
  wordId: z.string().optional(),
});
export type JournalBracket = z.infer<typeof JournalBracketSchema>;

export const UsedWellSchema = z.object({ itemRef: ItemRefSchema, span: SpanSchema });
export type UsedWell = z.infer<typeof UsedWellSchema>;

// ---- Phase 17: fully corrected sentences ---------------------------------
// The model returns, per sentence, a fully corrected version plus its edits.
// It never gives character offsets: code finds each edit by searching for
// `contextBefore + before` in the original (journal/edits.ts).

export const EditKindSchema = z.enum([
  'missing_word',
  'extra_word',
  'wrong_word',
  'word_order',
  'mainland_style',
  'measure_word',
  'particle',
  'other',
]);
export type EditKind = z.infer<typeof EditKindSchema>;

/** Phase 25: the Gemini model that served a reply (from the proxy's x-served-by header). */
export const ProviderNameSchema = z.string().min(1).max(100);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const SentenceEditSchema = z.object({
  /** Exact text from the original sentence ('' for an insertion). */
  before: z.string(),
  /** Replacement text ('' for a deletion). */
  after: z.string(),
  /** 1-3 characters before the edit, to anchor it. */
  contextBefore: z.string().default(''),
  kind: EditKindSchema,
  pattern: z.string().optional(),
  itemRef: ItemRefSchema.optional(),
  explanationEn: z.string(),
});
export type SentenceEdit = z.infer<typeof SentenceEditSchema>;

/** What the model returns for one numbered sentence. */
export const ModelSentenceReviewSchema = z.object({
  /** The number the sentence had in the request list (0-based). */
  index: z.number().int().min(0),
  corrected: z.string(),
  /** Optional freer rewrite; never used for clozes. */
  natural: z.string().optional(),
  /** English meaning of `corrected`. */
  en: z.string(),
  edits: z.array(SentenceEditSchema).default([]),
});
export type ModelSentenceReview = z.infer<typeof ModelSentenceReviewSchema>;

/** Phase 17 Part A: a sentence review once code has attached the original. */
export interface JournalSentenceReview {
  /** Copied exactly from the entry by code, never by the model. */
  original: string;
  corrected: string;
  natural?: string;
  en: string;
  edits: SentenceEdit[];
}

/** POST /v1/journal-sentence-fix — the single retry after the checker objected. */
export const JournalSentenceFixRequestSchema = z.object({
  original: z.string().min(1).max(300),
  /** The rejected correction and why it was rejected. */
  rejected: z.string().max(300),
  problem: z.string().max(500),
  learnerLevel: LevelSchema,
  protectedTerms: z.array(z.string().min(1).max(20)).max(20).default([]),
});
export type JournalSentenceFixRequest = z.infer<typeof JournalSentenceFixRequestSchema>;

/** POST /v1/journal-verify — the independent checker. It never sees the
 * learner's original sentence. */
export const JournalVerifyRequestSchema = z.object({
  zh: z.string().min(1).max(300),
  /** When given, the checker also confirms the Chinese means this. */
  en: z.string().max(400).optional(),
});
export type JournalVerifyRequest = z.infer<typeof JournalVerifyRequestSchema>;

export const JournalVerifyResponseSchema = z.object({
  ok: z.boolean(),
  /** Empty when ok. */
  problem: z.string(),
  /** true when no `en` was given. */
  meaningMatches: z.boolean(),
});
export type JournalVerifyResponse = z.infer<typeof JournalVerifyResponseSchema>;

/** POST /v1/journal-solve — the solver test: fill the blank without seeing the answer. */
export const JournalSolveRequestSchema = z.object({
  /** The sentence with the blank written as ＿＿＿＿. */
  sentence: z.string().min(1).max(300),
  en: z.string().max(400),
  hint: z.string().max(200),
});
export type JournalSolveRequest = z.infer<typeof JournalSolveRequestSchema>;

export const JournalSolveResponseSchema = z.object({
  /** Every fill the model thinks makes a correct, natural sentence, best first. */
  answers: z.array(z.string()).max(6),
  /** false when no sensible answer could be found. */
  confident: z.boolean(),
});
export type JournalSolveResponse = z.infer<typeof JournalSolveResponseSchema>;

/** Phase 5 §3 — the shape the LLM must return and the shape we keep after
 * validation. `natural_rewrite` stays snake_case to match the brief. */
export const JournalReviewSchema = z.object({
  issues: z.array(JournalIssueSchema),
  natural_rewrite: z.string(),
  brackets: z.array(JournalBracketSchema),
  used_well: z.array(UsedWellSchema),
  /** Phase 17: a fully corrected version of every numbered sentence in the
   * request, separate from the (capped) issues above. */
  sentences: z.array(ModelSentenceReviewSchema).optional(),
  /** Set by the client from the proxy's `x-served-by` header: which provider
   * wrote the corrections (the checker then uses the other one). */
  servedBy: ProviderNameSchema.optional(),
});
export type JournalReview = z.infer<typeof JournalReviewSchema>;

export const JournalReviewRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  learnerLevel: LevelSchema,
  /** Headwords the daily prompt asked the learner to try. */
  promptWords: z.array(z.string()).max(10).default([]),
  /** The learner's top recent error patterns — the model should look out
   * for these first (phase doc §3). */
  recurringPatterns: z.array(z.string()).max(10).default([]),
  /** Max issues the model should return. The client enforces it again. */
  maxIssues: z.number().int().positive().max(5).default(3),
  /** Phase 17: the entry split into sentences by code. The model reviews this
   * numbered list and returns one `sentences` item per number. */
  sentences: z.array(z.string().min(1).max(300)).max(40).optional(),
  /** Phase 17: the learner's own names. The model must not change them. */
  protectedTerms: z.array(z.string().min(1).max(20)).max(20).optional(),
  /** Phase 17: only `sentences` is wanted (rebuilding old items). */
  sentencesOnly: z.boolean().optional(),
  /** Phase 31 Part C.2: "What did you mean?" in the learner's words. Corrections aim at it. */
  intendedEn: z.string().max(400).optional(),
});
export type JournalReviewRequest = z.infer<typeof JournalReviewRequestSchema>;

/** POST /v1/journal-check — "an LLM check for alternatives" (phase doc §4.2):
 * is the learner's own fix of a flagged span acceptable even though it
 * differs from the suggested correction? */
export const JournalCheckRequestSchema = z.object({
  sentence: z.string().min(1).max(500),
  original: z.string(),
  attempt: z.string().min(1).max(200),
  correction: z.string(),
});
export type JournalCheckRequest = z.infer<typeof JournalCheckRequestSchema>;

/** Phase 31 Part B: another wording the checker offers, with its own meaning; code then checks
 * whether it keeps the learner's meaning. */
export const AlternativeSchema = z.object({ zh: z.string().min(1).max(60), meaningEn: z.string().max(200) });
export type Alternative = z.infer<typeof AlternativeSchema>;

export const JournalCheckResponseSchema = z.object({
  acceptable: z.boolean(),
  /** Why it is still off (only shown when not acceptable). Never lists other wordings. */
  noteEn: z.string(),
  alternatives: z.array(AlternativeSchema).max(3).default([]),
});
export type JournalCheckResponse = z.infer<typeof JournalCheckResponseSchema>;

/** POST /v1/journal-explain — the "explain more" follow-up (phase doc §5). */
export const JournalExplainRequestSchema = z.object({
  sentence: z.string().min(1).max(500),
  original: z.string(),
  correction: z.string(),
  explanationEn: z.string(),
  learnerLevel: LevelSchema,
});
export type JournalExplainRequest = z.infer<typeof JournalExplainRequestSchema>;

export const JournalExplainResponseSchema = z.object({
  explanationEn: z.string(),
  examples: z.array(z.object({ zh: z.string(), en: z.string() })).max(3),
});
export type JournalExplainResponse = z.infer<typeof JournalExplainResponseSchema>;

/** POST /v1/journal-explain-check — Phase 31 Part A.4: the independent check (checker model) that
 * each explanation matches its correction and is true. */
export const JournalExplainCheckRequestSchema = z.object({
  items: z
    .array(
      z.object({
        sentence: z.string().min(1).max(500),
        original: z.string().max(100),
        correction: z.string().max(100),
        type: IssueTypeSchema,
        explain: IssueExplanationSchema,
        intendedEn: z.string().max(400).optional(),
      }),
    )
    .min(1)
    .max(5),
});
export type JournalExplainCheckRequest = z.infer<typeof JournalExplainCheckRequestSchema>;

export const JournalExplainCheckResponseSchema = z.object({
  results: z
    .array(z.object({ index: z.number().int().min(0), ok: z.boolean(), problem: z.string().max(300) }))
    .max(5),
});
export type JournalExplainCheckResponse = z.infer<typeof JournalExplainCheckResponseSchema>;

/** POST /v1/journal-why — Phase 31: a fresh "Why?" for one correction after the check objected. */
export const JournalWhyRequestSchema = z.object({
  sentence: z.string().min(1).max(500),
  original: z.string().max(100),
  correction: z.string().max(100),
  type: IssueTypeSchema,
  intendedEn: z.string().max(400).optional(),
  /** What the check said was wrong with the earlier explanation ('' when there was none). */
  problem: z.string().max(300),
  learnerLevel: LevelSchema,
});
export type JournalWhyRequest = z.infer<typeof JournalWhyRequestSchema>;

/** POST /v1/journal-ask — Phase 31 Part C.1: "Ask about this", up to 5 turns about one correction. */
export const JOURNAL_ASK_MAX_TURNS = 5;
export const JournalAskRequestSchema = z.object({
  sentence: z.string().min(1).max(500),
  original: z.string().max(100),
  correction: z.string().max(100),
  explanation: z.string().max(1200),
  learnerLevel: LevelSchema,
  /** Words the learner knows (vocabulary ladder rung 1), for the examples. */
  knownWords: z.array(z.string().min(1).max(12)).max(80).default([]),
  history: z
    .array(z.object({ q: z.string().max(400), a: z.string().max(1500) }))
    .max(JOURNAL_ASK_MAX_TURNS - 1)
    .default([]),
  question: z.string().min(1).max(400),
});
export type JournalAskRequest = z.infer<typeof JournalAskRequestSchema>;

export const JournalAskResponseSchema = z.object({
  answerEn: z.string().min(1).max(1500),
  examples: z.array(z.object({ zh: z.string(), en: z.string() })).max(3).default([]),
});
export type JournalAskResponse = z.infer<typeof JournalAskResponseSchema>;

/** One saved "Ask about this" turn. */
export interface JournalAskTurn {
  q: string;
  a: string;
  examples: { zh: string; en: string }[];
  at: Date;
}

/** POST /v1/journal-gap — Phase 31 Part D: an `[english]` gap translated in its sentence. */
export const JournalGapRequestSchema = z.object({
  /** The sentence with the gap written as ＿＿. */
  sentence: z.string().min(1).max(300),
  en: z.string().min(1).max(60),
  /** Lexicon words whose gloss matches. */
  candidates: z.array(z.object({ zh: z.string(), glossEn: z.string() })).max(10).default([]),
  learnerLevel: LevelSchema,
  intendedEn: z.string().max(400).optional(),
});
export type JournalGapRequest = z.infer<typeof JournalGapRequestSchema>;

export const GapOptionSchema = z.object({
  /** The word or phrase to learn (人很好, 親切, 宜人). */
  zh: z.string().min(1).max(20),
  pinyin: z.string().max(80),
  meaningEn: z.string().max(120),
  /** One line: "宜人: pleasant, for weather or places, not people". */
  usageEn: z.string().max(200),
  /** The learner's whole sentence with the gap filled this way. */
  corrected: z.string().min(1).max(300),
});
export type GapOption = z.infer<typeof GapOptionSchema>;

export const JournalGapResponseSchema = z.object({ options: z.array(GapOptionSchema).max(3) });
export type JournalGapResponse = z.infer<typeof JournalGapResponseSchema>;

/** The exercise a journal review item asks for (Phase 17 Part C). Every
 * exercise is built on a sentence that passed Part B. */
export type ErrorExerciseKind = 'cloze' | 'choice' | 'extra_word' | 'reorder' | 'fix';

export interface ErrorExercise {
  kind: ErrorExerciseKind;
  /** The prompt line: what kind of fix this is ("A word is missing here."). */
  prompt: string;
  /** cloze / choice: the blank inside `corrected`. */
  blankStart?: number;
  blankEnd?: number;
  /** cloze / choice: the answer. */
  answer?: string;
  /** cloze / choice: accepted answers. fix: accepted whole sentences.
   * reorder: accepted whole sentences. Grows through "I think mine is right too". */
  accepted: string[];
  /** choice: the two options, learner's wording first. */
  options?: string[];
  /** extra_word: tokens of the learner's sentence. reorder: tokens in the
   * correct order (the UI shuffles them). */
  tokens?: string[];
  /** extra_word: which token doesn't belong, plus any later-approved taps. */
  extraTokenIndex?: number;
  acceptedTaps?: number[];
  /** What the solver test found when the item was built. */
  solver?: { answers: string[]; confident: boolean };
}

/** Phase 16: only `active` items are ever shown. `pending_check` waits for
 * the pre-show check (never shown meanwhile); `blocked` failed it (reason in
 * `blockedReason`); `reported` was reported by the learner; `deleted` is
 * kept only so a sync doesn't resurrect it. `pending_rebuild` (Phase 17) is a
 * legacy item waiting to be rebuilt. */
export type ErrorItemStatus =
  | 'active'
  | 'pending_check'
  | 'blocked'
  | 'reported'
  | 'deleted'
  | 'pending_rebuild';

export const ClozeReportReasonSchema = z.enum([
  'garbled',
  'wrong_answer',
  'other_answer_fits',
  'blank_misplaced',
  'english_wrong',
  'other',
]);
export type ClozeReportReason = z.infer<typeof ClozeReportReasonSchema>;

export interface ClozeReport {
  reason: ClozeReportReason;
  note?: string;
  reportedAt: Date;
  profileId: string;
}

/** Phase 5 §7, rebuilt in Phase 17. Scheduled with FSRS. `corrected` is a
 * fully corrected, independently checked sentence; `original` is what the
 * learner wrote. `marks` say where the one tested change sits in each.
 * Rows without `version: 2` are the old one-span-patched items: they are
 * never shown, and the migration rebuilds or blocks them. */
export interface ErrorItem {
  id: string;
  journalEntryId: string;
  original: string;
  corrected: string;
  /** Where the tested edit sits in `original` (empty for an insertion). */
  span: [number, number];
  type: IssueType;
  pattern?: string;
  itemRef?: ItemRef;
  card: Card;
  flagged: boolean;
  createdAt: Date;
  /** 2 = built by Phase 17. Absent = legacy. */
  version?: 2;
  status?: ErrorItemStatus;
  blockedReason?: string;
  /** Phase 16: set when status is `reported`. */
  report?: ClozeReport;
  /** Phase 16: the blank inside `corrected` when other corrections in the same
   * sentence were applied too (otherwise derived from `span`). */
  blank?: [number, number];
  /** English meaning of `corrected`. */
  en?: string;
  explanationEn?: string;
  editKind?: EditKind;
  /** The highlighted change in each sentence. */
  marks?: { original: Span[]; corrected: Span[] };
  exercise?: ErrorExercise;
  /** Phase 31 Part E: the checked "Why?" of the correction this item practises. */
  why?: IssueExplanation;
}
