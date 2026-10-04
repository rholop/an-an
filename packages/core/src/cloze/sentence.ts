import { z } from 'zod';
import { LevelSchema } from '../chat/level-schema.js';

// Phase 4 §1 sentence bank entry shape — shared between data-pipeline
// (writes data/build/sentences.v*.json) and apps/proxy's /v1/sentences
// (generates candidates for the pipeline to validate), mirroring chat/types.ts's
// "schemas live in core" convention.

export const SentenceTokenSchema = z.object({
  text: z.string(),
  lemma: z.string().optional(),
});
export type SentenceToken = z.infer<typeof SentenceTokenSchema>;

export const SentenceBankEntrySchema = z.object({
  id: z.string(),
  zh: z.string(),
  en: z.string(),
  targetWordId: z.string(),
  level: LevelSchema,
  tokens: z.array(SentenceTokenSchema),
  /** "generated" = built offline into data/build (phase doc §1);
   * "generated-live" = produced on demand for the reader (phase 9) and kept in
   * the learner's own profile. Kept as an enum rather than a free string so a
   * new source is a deliberate, reviewed addition here, not a silent typo. */
  source: z.enum(['generated', 'generated-live', 'textbook']),
  /** Phase 4 §1's "second-pass check... flag doubtful ones" — still shipped
   * (unlike an analyzeText failure, which is dropped outright), just
   * surfaced for human review rather than silently trusted. */
  doubtful: z.boolean().default(false),
  /** Phase 12: textbook sentences carry `textbook:laixue-1`, `…:L03` tags, the
   * lesson they were written for and the grammar items they exercise. */
  tags: z.array(z.string()).optional(),
  lesson: z.number().int().optional(),
  grammarIds: z.array(z.string()).optional(),
});
export type SentenceBankEntry = z.infer<typeof SentenceBankEntrySchema>;

export const SentenceBankFileSchema = z.object({
  meta: z.object({ version: z.string(), buildDate: z.string(), level: LevelSchema }),
  sentences: z.array(SentenceBankEntrySchema),
});
export type SentenceBankFile = z.infer<typeof SentenceBankFileSchema>;

// apps/proxy's POST /v1/sentences — the pipeline's batch generation calls
// this (reusing the orchestrator's provider-fallback/cache/budget plumbing)
// rather than the pipeline talking to Gemini/OpenAI directly (CLAUDE.md:
// "A small backend LLM proxy holds the API keys").

export const SentenceGenRequestSchema = z.object({
  word: z.object({
    headword: z.string(),
    pinyin: z.string(),
    level: LevelSchema,
    glossEn: z.string(),
  }),
  /** Headwords at/below the word's level to compose the sentence from
   * (phase doc §1: "using only words at or below its level, plus the
   * word"). */
  allowedVocab: z.array(z.string()),
  count: z.number().int().positive().max(10).default(5),
});
export type SentenceGenRequest = z.infer<typeof SentenceGenRequestSchema>;

export const SentenceGenResponseSchema = z.object({
  sentences: z.array(
    z.object({
      zh: z.string(),
      en: z.string(),
      tokens: z.array(SentenceTokenSchema),
    }),
  ),
});
export type SentenceGenResponse = z.infer<typeof SentenceGenResponseSchema>;
