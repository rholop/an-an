/**
 * Hand-written JSON-schema-shaped object describing TurnResponse, for both
 * providers' structured-output modes (CLAUDE.md §1: "Use each provider's
 * structured-output / JSON-schema mode"). Kept as one shared object rather
 * than deriving from the zod schema (no extra zod-to-json-schema dependency)
 * — if TurnResponseSchema in @anan/core changes, update this by hand and
 * let json-schema-shape.test.ts catch drift.
 *
 * This is deliberately close to both providers' accepted subsets (no $ref,
 * no oneOf/anyOf) — Gemini's responseSchema is a restricted OpenAPI-3 subset,
 * OpenAI's json_schema mode wants plain JSON Schema with
 * additionalProperties:false — this object satisfies both.
 */
export const TURN_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply_zh: { type: 'string' },
    reply_en: { type: 'string' },
    tokens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          lemma: { type: 'string' },
        },
        required: ['text'],
      },
    },
    targets_used: { type: 'array', items: { type: 'string' } },
    suggested_replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          zh: { type: 'string' },
          en: { type: 'string' },
        },
        required: ['zh', 'en'],
      },
    },
    goal_progress: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'string' },
          done: { type: 'boolean' },
        },
        required: ['step', 'done'],
      },
    },
    recast_zh: { type: 'string' },
  },
  required: ['reply_zh', 'reply_en', 'tokens', 'targets_used', 'suggested_replies', 'goal_progress'],
} as const;
