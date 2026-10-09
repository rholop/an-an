import { z } from 'zod';
import { LevelSchema } from '../chat/level-schema.js';

/** Phase 24 wire shapes. POST /v1/story writes a story; POST /v1/story-check reads it independently. */

export const StoryRequestSchema = z.object({
  /** What the story is about (lesson theme, a journal topic, typed or a chip). */
  topic: z.string().min(1).max(200),
  learnerLevel: LevelSchema,
  length: z.object({ min: z.number().int().min(20).max(2000), max: z.number().int().min(20).max(2000) }),
  /** Headwords by rung: 1 (known; at most 300), 2 (this lesson; use each 2–3 times), 3 (next lesson,
   * at most `budget.rung3` of them), 4 (the lesson after), 5 (current level). */
  rungs: z.object({
    r1: z.array(z.string().max(20)).max(400),
    r2: z.array(z.string().max(20)).max(200),
    r3: z.array(z.string().max(20)).max(200),
    r4: z.array(z.string().max(20)).max(200),
    r5: z.array(z.string().max(20)).max(100),
  }),
  budget: z.object({
    rung1Share: z.number().min(0).max(1),
    rung3: z.number().int().min(0).max(10),
    rung4: z.number().int().min(0).max(10),
    rung5: z.number().int().min(0).max(10),
  }),
  /** Grammar patterns of learned and active lessons; `grammarNext` may appear once. */
  grammar: z.array(z.string().max(60)).max(80),
  grammarNext: z.array(z.string().max(60)).max(20),
  /** Names the learner has met (textbook characters), and the series' characters for "Continue a story". */
  names: z.array(z.string().max(20)).max(40),
  /** "Continue a story": the previous episode, so the same characters carry on. */
  previous: z.object({ title: z.string().max(80), summaryEn: z.string().max(600) }).optional(),
  /** Regeneration feedback naming the over-budget words and simpler swaps. */
  feedback: z.string().max(1500).optional(),
  /** Phase 26: rungs 2 and 1 grouped (this lesson, people, places, food, time, verbs…) with short
   * English glosses, topic words first. When given, the prompt shows these instead of the flat r1/r2. */
  groups: z
    .array(
      z.object({
        label: z.string().max(40),
        words: z.array(z.object({ zh: z.string().max(20), en: z.string().max(40) })).max(300),
      }),
    )
    .max(12)
    .optional(),
  /** Phase 26: raised on every attempt (saved or not), so a retry is a different request. */
  variant: z.number().int().min(0).max(10_000).optional(),
  /** Phase 26: regeneration and repair calls skip the proxy cache. */
  fresh: z.boolean().optional(),
});
export type StoryRequest = z.infer<typeof StoryRequestSchema>;

export const StoryQuestionSchema = z.object({
  q_zh: z.string().min(1).max(120),
  q_en: z.string().min(1).max(200),
  options: z
    .array(z.object({ zh: z.string().min(1).max(60), en: z.string().min(1).max(120) }))
    .min(2)
    .max(5),
  /** Index into `options`. */
  answer: z.number().int().min(0).max(4),
});
export type StoryQuestion = z.infer<typeof StoryQuestionSchema>;

export const StoryResponseSchema = z.object({
  title_zh: z.string().min(1).max(40),
  title_en: z.string().min(1).max(120),
  paragraphs: z
    .array(z.object({ zh: z.string().min(1).max(600), en: z.string().min(1).max(1200) }))
    .min(1)
    .max(12),
  summary_en: z.string().min(1).max(600),
  /** Inline glosses for words outside the lists (a place name…): rung 6 is allowed only glossed. */
  glosses: z.array(z.object({ zh: z.string().min(1).max(20), en: z.string().min(1).max(80) })).max(6),
  /** The people in the story (for "Continue a story"). */
  characters: z.array(z.string().min(1).max(20)).max(8),
  questions: z.array(StoryQuestionSchema).min(1).max(6),
  /** Phase 26 self-check: every word used that is NOT in rungs 1–2 (the known list and this lesson). */
  newWords: z.array(z.object({ zh: z.string().min(1).max(20), en: z.string().max(80) })).max(20).optional(),
});
export type StoryResponse = z.infer<typeof StoryResponseSchema>;

/** Phase 26 Part B: only the sentences with a problem word go back to the writer. */
export const StoryRepairRequestSchema = z.object({
  learnerLevel: LevelSchema,
  /** The whole story, so each rewrite still fits it. */
  story: z.array(z.string().min(1).max(600)).min(1).max(12),
  sentences: z
    .array(
      z.object({
        /** Index of the sentence in the whole story (0-based, in reading order). */
        i: z.number().int().min(0).max(200),
        zh: z.string().min(1).max(300),
        problems: z
          .array(
            z.object({
              zh: z.string().min(1).max(20),
              en: z.string().max(80),
              /** Why: "not in your lists", "simplified character" … */
              why: z.string().max(120),
              swaps: z.array(z.string().max(20)).max(6),
            }),
          )
          .max(10),
      }),
    )
    .min(1)
    .max(20),
  /** The words to use: rungs 1–2 headwords. */
  words: z.array(z.string().max(20)).max(400),
  names: z.array(z.string().max(20)).max(40),
  variant: z.number().int().min(0).max(10_000).optional(),
});
export type StoryRepairRequest = z.infer<typeof StoryRepairRequestSchema>;

export const StoryRepairResponseSchema = z.object({
  sentences: z.array(z.object({ i: z.number().int().min(0).max(200), zh: z.string().min(1).max(300) })).max(20),
  /** New English for each paragraph that changed. */
  paragraphsEn: z.array(z.object({ p: z.number().int().min(0).max(11), en: z.string().min(1).max(1200) })).max(12).default([]),
  /** Words still used that are not in the list. */
  newWords: z.array(z.object({ zh: z.string().min(1).max(20), en: z.string().max(80) })).max(20).default([]),
});
export type StoryRepairResponse = z.infer<typeof StoryRepairResponseSchema>;

/** The independent reader (the other provider, never shown the prompt or the word lists). */
export const StoryCheckRequestSchema = z.object({
  paragraphs: z.array(z.string().min(1).max(600)).min(1).max(12),
  summaryEn: z.string().min(1).max(600),
  questions: z
    .array(z.object({ q: z.string().min(1).max(120), options: z.array(z.string().min(1).max(60)).min(2).max(5) }))
    .max(6),
  /** Phase 26: glosses of words outside the lexicon (from the writer), to confirm. */
  glosses: z.array(z.object({ zh: z.string().min(1).max(20), en: z.string().min(1).max(80) })).max(10).optional(),
});
export type StoryCheckRequest = z.infer<typeof StoryCheckRequestSchema>;

export const StoryCheckResponseSchema = z.object({
  /** Natural, coherent Taiwan Mandarin in traditional characters. */
  natural: z.boolean(),
  coherent: z.boolean(),
  taiwan: z.boolean(),
  summaryMatches: z.boolean(),
  /** Empty when everything is fine. */
  problems: z.array(z.string().max(300)).max(10),
  /** For each question, every option index that is a correct answer according to the story. */
  correctOptions: z.array(z.array(z.number().int().min(0).max(4)).max(5)).max(6),
  /** Phase 26: every given gloss is right for its word in this story (true when none were given). */
  glossesOk: z.boolean().optional(),
});
export type StoryCheckResponse = z.infer<typeof StoryCheckResponseSchema>;

/** Phase 26 Part E: a story written ahead for one textbook lesson (`pnpm stories:build`). */
export const LessonStorySchema = z.object({
  id: z.string().min(1).max(80),
  bookId: z.string().min(1).max(40),
  lessonId: z.string().min(1).max(60),
  level: LevelSchema,
  topic: z.string().min(1).max(200),
  story: StoryResponseSchema,
});
export type LessonStory = z.infer<typeof LessonStorySchema>;
export const LessonStoriesFileSchema = z.object({ version: z.literal(1), stories: z.array(LessonStorySchema) });
export type LessonStoriesFile = z.infer<typeof LessonStoriesFileSchema>;
