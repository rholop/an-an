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

export const JournalIssueSchema = z.object({
  span: SpanSchema,
  type: IssueTypeSchema,
  pattern: z.string().optional(),
  itemRef: ItemRefSchema.optional(),
  correction: z.string(),
  explanationEn: z.string(),
  confidence: IssueConfidenceSchema,
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

/** Phase 5 §3 — the shape the LLM must return and the shape we keep after
 * validation. `natural_rewrite` stays snake_case to match the brief. */
export const JournalReviewSchema = z.object({
  issues: z.array(JournalIssueSchema),
  natural_rewrite: z.string(),
  brackets: z.array(JournalBracketSchema),
  used_well: z.array(UsedWellSchema),
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

export const JournalCheckResponseSchema = z.object({
  acceptable: z.boolean(),
  noteEn: z.string(),
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

/** Phase 5 §7. Scheduled with FSRS and reviewed as a cloze of `corrected`,
 * blanking the corrected span. `original`/`corrected` are the *sentence*
 * containing the issue before and after the fix, and `span` locates the
 * wrong text inside `original`; the blank in `corrected` is derived
 * (see errorBlankSpan) because everything outside the span is identical. */
export interface ErrorItem {
  id: string;
  journalEntryId: string;
  original: string;
  corrected: string;
  span: [number, number];
  type: IssueType;
  pattern?: string;
  itemRef?: ItemRef;
  card: Card;
  flagged: boolean;
  createdAt: Date;
}
