// Phase 39: tutoring sessions. The wire shapes shared by apps/proxy (/v1/tutor-*) and apps/web.
// Everything a model returns here is a draft to check in code, never truth.
import { z } from 'zod';
import { LevelSchema } from '../chat/level-schema.js';

/** One rendered page of the class summary PDF (JPEG or PNG, base64 without the data: prefix). */
export const TutorPageImageSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png']),
  data: z.string().min(1).max(3_000_000),
});
export type TutorPageImage = z.infer<typeof TutorPageImageSchema>;

/** POST /v1/tutor-extract: every page of one PDF in one request. */
export const TutorExtractRequestSchema = z.object({
  pages: z.array(TutorPageImageSchema).min(1).max(12),
});
export type TutorExtractRequest = z.infer<typeof TutorExtractRequestSchema>;

export const TutorExampleSchema = z.object({
  zh: z.string().max(200),
  en: z.string().max(300),
});
export type TutorExample = z.infer<typeof TutorExampleSchema>;

/**
 * The extraction, exactly as printed (simplified characters, the notes' own pinyin and glosses). The
 * date is the class's local date and time as printed, written "YYYY-MM-DDTHH:MM".
 */
export const TutorExtractionSchema = z.object({
  date: z.string().max(40),
  tutor: z.string().max(60),
  topics: z.array(z.object({ zh: z.string().max(60), en: z.string().max(120) })).max(12),
  vocab: z
    .array(
      z.object({
        zh: z.string().min(1).max(20),
        pinyin: z.string().max(80),
        en: z.string().max(200),
        example: TutorExampleSchema,
      }),
    )
    .max(60),
  grammar: z
    .array(
      z.object({
        name: z.string().max(80),
        explanationEn: z.string().max(800),
        example: TutorExampleSchema,
      }),
    )
    .max(30),
});
export type TutorExtraction = z.infer<typeof TutorExtractionSchema>;

/** POST /v1/tutor-check (checker chain): is each kept sentence natural Taiwan Mandarin that says its English? */
export const TutorCheckRequestSchema = z.object({
  sentences: z.array(z.object({ id: z.string().max(40), zh: z.string().max(200), en: z.string().max(300) })).min(1).max(60),
});
export type TutorCheckRequest = z.infer<typeof TutorCheckRequestSchema>;

export const TutorCheckResponseSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().max(40),
        ok: z.boolean(),
        /** A corrected sentence when it was close (traditional, Taiwan wording). */
        fixedZh: z.string().max(200).optional(),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(60),
});
export type TutorCheckResponse = z.infer<typeof TutorCheckResponseSchema>;

/** POST /v1/tutor-scenario: one chat scenario from a class's topics, words and grammar. */
export const TutorScenarioRequestSchema = z.object({
  tutor: z.string().max(60),
  topics: z.array(z.object({ zh: z.string().max(60), en: z.string().max(120) })).max(12),
  /** The class's words (traditional headwords). */
  words: z.array(z.string().max(20)).max(60),
  /** Grammar patterns the chat should lean on. */
  grammar: z.array(z.string().max(80)).max(12),
  learnerLevel: LevelSchema,
});
export type TutorScenarioRequest = z.infer<typeof TutorScenarioRequestSchema>;

export const TutorScenarioResponseSchema = z.object({
  title: z.string().max(80),
  setting: z.string().max(400),
  npcName: z.string().max(20),
  personality: z.string().max(200),
  speechStyle: z.string().max(200),
  goalSteps: z
    .array(z.object({ description: z.string().max(160), keywordHints: z.array(z.string().max(20)).max(6) }))
    .min(1)
    .max(5),
  opener: TutorExampleSchema,
  successLine: TutorExampleSchema,
});
export type TutorScenarioResponse = z.infer<typeof TutorScenarioResponseSchema>;

/** The three model calls a tutoring upload makes (apps/web implements them over the proxy). */
export interface TutoringLLM {
  extractTutorSummary(req: TutorExtractRequest): Promise<TutorExtraction>;
  checkTutorSentences(req: TutorCheckRequest): Promise<TutorCheckResponse>;
  writeTutorScenario(req: TutorScenarioRequest): Promise<TutorScenarioResponse>;
}
