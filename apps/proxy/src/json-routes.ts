import {
  ClozeCheckResponseSchema,
  DefineResponseSchema,
  GlossAdjudicationResponseSchema,
  JournalCheckResponseSchema,
  JournalExplainResponseSchema,
  JournalReviewSchema,
  JournalSolveResponseSchema,
  JournalVerifyResponseSchema,
  ModelSentenceReviewSchema,
  SentenceGenResponseSchema,
  StoryCheckResponseSchema,
  StoryResponseSchema,
  StoryRepairResponseSchema,
  TopicWordsResponseSchema,
  TurnResponseSchema,
} from '@anan/core';
import type { z } from 'zod';
import {
  CLOZE_CHECK_JSON_SCHEMA,
  DEFINE_JSON_SCHEMA,
  GLOSS_JSON_SCHEMA,
  JOURNAL_CHECK_JSON_SCHEMA,
  JOURNAL_EXPLAIN_JSON_SCHEMA,
  JOURNAL_REVIEW_JSON_SCHEMA,
  JOURNAL_SENTENCE_FIX_JSON_SCHEMA,
  JOURNAL_SOLVE_JSON_SCHEMA,
  JOURNAL_VERIFY_JSON_SCHEMA,
  SENTENCE_GEN_RESPONSE_JSON_SCHEMA,
  STORY_CHECK_JSON_SCHEMA,
  STORY_REPAIR_JSON_SCHEMA,
  STORY_JSON_SCHEMA,
  TOPIC_WORDS_JSON_SCHEMA,
  TURN_RESPONSE_JSON_SCHEMA,
} from './json-schema.js';

/** Phase 25: every route that asks a model for JSON, with the zod check its answer must pass and
 * the schema the model is given (the contract tests walk this list). */
export const JSON_ROUTES: ReadonlyArray<{ route: string; zod: z.ZodTypeAny; json: object }> = [
  { route: '/v1/turn', zod: TurnResponseSchema, json: TURN_RESPONSE_JSON_SCHEMA },
  {
    route: '/v1/sentences',
    zod: SentenceGenResponseSchema,
    json: SENTENCE_GEN_RESPONSE_JSON_SCHEMA,
  },
  { route: '/v1/journal-review', zod: JournalReviewSchema, json: JOURNAL_REVIEW_JSON_SCHEMA },
  { route: '/v1/journal-check', zod: JournalCheckResponseSchema, json: JOURNAL_CHECK_JSON_SCHEMA },
  {
    route: '/v1/journal-explain',
    zod: JournalExplainResponseSchema,
    json: JOURNAL_EXPLAIN_JSON_SCHEMA,
  },
  {
    route: '/v1/journal-sentence-fix',
    zod: ModelSentenceReviewSchema,
    json: JOURNAL_SENTENCE_FIX_JSON_SCHEMA,
  },
  {
    route: '/v1/journal-verify',
    zod: JournalVerifyResponseSchema,
    json: JOURNAL_VERIFY_JSON_SCHEMA,
  },
  { route: '/v1/journal-solve', zod: JournalSolveResponseSchema, json: JOURNAL_SOLVE_JSON_SCHEMA },
  { route: '/v1/cloze-check', zod: ClozeCheckResponseSchema, json: CLOZE_CHECK_JSON_SCHEMA },
  { route: '/v1/topic-words', zod: TopicWordsResponseSchema, json: TOPIC_WORDS_JSON_SCHEMA },
  { route: '/v1/story', zod: StoryResponseSchema, json: STORY_JSON_SCHEMA },
  { route: '/v1/story-check', zod: StoryCheckResponseSchema, json: STORY_CHECK_JSON_SCHEMA },
  { route: '/v1/story-repair', zod: StoryRepairResponseSchema, json: STORY_REPAIR_JSON_SCHEMA },
  { route: '/v1/gloss', zod: GlossAdjudicationResponseSchema, json: GLOSS_JSON_SCHEMA },
  { route: '/v1/define', zod: DefineResponseSchema, json: DEFINE_JSON_SCHEMA },
];
