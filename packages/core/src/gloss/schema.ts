import { z } from 'zod';
import { LevelSchema } from '../chat/level-schema.js';

// Phase 7 §B2: offline gloss adjudication. The model CHOOSES and CONDENSES
// from the candidate senses we give it; it never writes a definition from
// memory. Shared by apps/proxy (POST /v1/gloss) and data-pipeline (client).

export const SenseSourceSchema = z.enum([
  'cedict',
  'moe-cedict',
  'wiktionary',
  'top2011',
  'moe-zh',
]);
export type SenseSource = z.infer<typeof SenseSourceSchema>;

export const SenseCandidateSchema = z.object({
  /** Stable within one request: "c1", "c2" … */
  id: z.string(),
  source: SenseSourceSchema,
  pos: z.string().optional(),
  glossEn: z.string().optional(),
  defZh: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type SenseCandidate = z.infer<typeof SenseCandidateSchema>;

export const GlossAdjudicationRequestSchema = z.object({
  word: z.object({
    id: z.string(),
    headword: z.string(),
    pinyin: z.string(),
    pos: z.array(z.string()),
    level: LevelSchema.nullable(),
  }),
  moeDefsZh: z.array(z.string()).max(6).default([]),
  candidates: z.array(SenseCandidateSchema).min(1).max(30),
  examples: z
    .array(z.object({ zh: z.string(), en: z.string() }))
    .max(2)
    .default([]),
});
export type GlossAdjudicationRequest = z.infer<typeof GlossAdjudicationRequestSchema>;

export const GlossAdjudicationResponseSchema = z.object({
  senses: z
    .array(
      z.object({
        id: z.string(),
        glossEn: z.string(),
        noteEn: z.string().optional(),
        register: z.string().optional(),
        taiwanOnly: z.boolean().optional(),
        /** Candidate ids (request.candidates[].id) this sense was condensed from. */
        basedOn: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(6),
  primarySenseId: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type GlossAdjudicationResponse = z.infer<typeof GlossAdjudicationResponseSchema>;

/** POST /v1/define — runtime fallback for a word that is NOT in the lexicon.
 * Always shown labelled "AI-generated" and queued for human review. */
export const DefineRequestSchema = z.object({
  word: z.string().min(1).max(20),
  /** The sentence it appeared in, for sense disambiguation. */
  context: z.string().max(300).optional(),
});
export type DefineRequest = z.infer<typeof DefineRequestSchema>;

export const DefineResponseSchema = z.object({
  pinyin: z.string(),
  glossEn: z.string(),
  noteEn: z.string().optional(),
});
export type DefineResponse = z.infer<typeof DefineResponseSchema>;
