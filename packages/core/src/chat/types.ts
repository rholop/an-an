import { z } from 'zod';
import { LevelSchema } from './level-schema.js';

// Shared between apps/proxy (request handling) and apps/web (fetch calls) —
// phase doc §3 "Request/response validated with zod schemas that live in
// core and are shared with the web app." Keep this the single source of
// truth for the wire shape; don't redeclare it as a plain interface anywhere
// else.

export const TurnHistoryEntrySchema = z.object({
  role: z.enum(['npc', 'learner']),
  zh: z.string(),
  en: z.string().optional(),
});

export type TurnHistoryEntry = z.infer<typeof TurnHistoryEntrySchema>;

export const TurnRequestSchema = z.object({
  scenarioId: z.string(),
  npcId: z.string(),
  history: z.array(TurnHistoryEntrySchema),
  /** Internal: set by apps/web when regenerating after a failed client-side
   * validation (phase doc §4) — names the offending words and asks for
   * simpler replacements. Not part of the "public" contract a caller
   * normally fills in. */
  feedback: z.string().optional(),
  learnerLevel: LevelSchema,
  vocab: z.object({
    knownSample: z.array(z.string()),
    due: z.array(z.string()),
    targets: z.array(z.string()),
    allowedExtras: z.array(z.string()),
  }),
  scaffolding: z.enum(['high', 'medium', 'low']),
  englishFallback: z.boolean(),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const TurnTokenSchema = z.object({
  text: z.string(),
  lemma: z.string().optional(),
});
export type TurnToken = z.infer<typeof TurnTokenSchema>;

export const SuggestedReplySchema = z.object({
  zh: z.string(),
  en: z.string(),
});

export const GoalProgressStepSchema = z.object({
  step: z.string(),
  done: z.boolean(),
});

/** The shape the LLM itself must return as JSON (structured-output /
 * JSON-schema mode on the provider side) — see apps/proxy's adapters. */
export const TurnResponseSchema = z.object({
  reply_zh: z.string(),
  reply_en: z.string(),
  tokens: z.array(TurnTokenSchema),
  targets_used: z.array(z.string()),
  suggested_replies: z.array(SuggestedReplySchema),
  goal_progress: z.array(GoalProgressStepSchema),
  recast_zh: z.string().optional(),
});
export type TurnResponse = z.infer<typeof TurnResponseSchema>;

/**
 * core's own LLM-agnostic contract — apps/web implements this via fetch to
 * apps/proxy; tests use a fake. Phase 5 adds reviewJournal(); Phase 4 may
 * add generateSentences().
 */
export interface TutorLLM {
  generateTurn(req: TurnRequest): Promise<TurnResponse>;
}
