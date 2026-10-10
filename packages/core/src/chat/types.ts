import { z } from 'zod';
import { LevelSchema } from './level-schema.js';
import type { DefineRequest, DefineResponse } from '../gloss/schema.js';
import type { SentenceGenRequest, SentenceGenResponse } from '../cloze/sentence.js';
import type { OpenTurnRequest, TopicWordsRequest, TopicWordsResponse } from './openChat.js';
import type {
  JournalCheckRequest,
  JournalCheckResponse,
  JournalExplainRequest,
  JournalExplainCheckRequest,
  JournalExplainCheckResponse,
  JournalWhyRequest,
  IssueExplanation,
  JournalAskRequest,
  JournalAskResponse,
  JournalGapRequest,
  JournalGapResponse,
  JournalExplainResponse,
  JournalReview,
  JournalReviewRequest,
  JournalSentenceFixRequest,
  JournalSolveRequest,
  JournalSolveResponse,
  JournalVerifyRequest,
  JournalVerifyResponse,
  ModelSentenceReview,
  ProviderName,
} from '../journal/types.js';

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
  /** Phase 21: a reply that kept failing the Taiwan / traditional check is retried once on the
   * fallback Gemini model (GEMINI_MODEL_FALLBACK) first. */
  alternateModel: z.boolean().optional(),
  learnerLevel: LevelSchema,
  vocab: z.object({
    knownSample: z.array(z.string()),
    due: z.array(z.string()),
    targets: z.array(z.string()),
    allowedExtras: z.array(z.string()),
    /** Phase 7: candidate senses for target/extra words that have more than
     * one, so the model can PICK a sense id per token (never write a
     * definition). Kept small: only these words, max ~8. */
    senseOptions: z
      .array(
        z.object({
          word: z.string(),
          senses: z.array(z.object({ id: z.string(), gloss: z.string() })),
        }),
      )
      .optional(),
  }),
  scaffolding: z.enum(['high', 'medium', 'low']),
  englishFallback: z.boolean(),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const TurnTokenSchema = z.object({
  text: z.string(),
  lemma: z.string().optional(),
  /** Phase 7: the sense the model meant, chosen from `vocab.senseOptions`.
   * Validated in code; an unknown id is dropped (the primary sense shows). */
  sense_id: z.string().optional(),
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
 * apps/proxy; tests use a fake. Phase 5 adds the journal methods. Their
 * results are raw model output: callers must run validateJournalReview()
 * (journal/validate.ts) before trusting any of it.
 */
export interface TutorLLM {
  generateTurn(req: TurnRequest): Promise<TurnResponse>;
  reviewJournal(req: JournalReviewRequest): Promise<JournalReview>;
  /** Is the learner's own fix of a flagged span acceptable? */
  checkJournalFix(req: JournalCheckRequest): Promise<JournalCheckResponse>;
  /** The "explain more" follow-up on one correction. */
  explainJournalIssue(req: JournalExplainRequest): Promise<JournalExplainResponse>;
  /** Phase 7: runtime definition for a word that is NOT in the lexicon only.
   * The result is shown labelled "AI-generated" and queued for review. */
  defineWord(req: DefineRequest): Promise<DefineResponse>;
  /** Phase 17: one corrected sentence again, after the checker objected. */
  fixJournalSentence(
    req: JournalSentenceFixRequest,
  ): Promise<{ review: ModelSentenceReview; servedBy?: ProviderName }>;
  /** Phase 17: the independent checker (never sees the original sentence). */
  verifyJournalSentence(req: JournalVerifyRequest): Promise<JournalVerifyResponse>;
  /** Phase 17: the cloze solver test. */
  solveJournalCloze(req: JournalSolveRequest): Promise<JournalSolveResponse>;
  /** Phase 16: is this full corrected sentence natural Taiwan Mandarin? */
  checkCloze(req: { sentence: string }): Promise<{ ok: boolean; reason?: string }>;
  /** Phase 9: on-demand example sentences for the reader (POST /v1/sentences).
   * Optional so implementations that never generate (tests) needn't stub it. */
  generateSentences?(req: SentenceGenRequest): Promise<SentenceGenResponse>;
  /** Phase 18: one Open chat turn (POST /v1/turn with `mode: 'open'`). Optional like the above. */
  generateOpenTurn?(req: OpenTurnRequest): Promise<TurnResponse>;
  /** Phase 18: ~60 words for a topic (POST /v1/topic-words). */
  generateTopicWords?(req: TopicWordsRequest): Promise<TopicWordsResponse>;
  /** Phase 31: the independent check of each correction's "Why?" (checker model). */
  checkJournalExplanations?(req: JournalExplainCheckRequest): Promise<JournalExplainCheckResponse>;
  /** Phase 31: a fresh "Why?" after the check objected. */
  explainJournalWhy?(req: JournalWhyRequest): Promise<IssueExplanation>;
  /** Phase 31: "Ask about this" on one correction. */
  askJournal?(req: JournalAskRequest): Promise<JournalAskResponse>;
  /** Phase 31: an `[english]` gap translated in its sentence. */
  fillJournalGap?(req: JournalGapRequest): Promise<JournalGapResponse>;
}
