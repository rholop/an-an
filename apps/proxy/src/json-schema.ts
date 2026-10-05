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
          sense_id: { type: 'string' },
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
  required: [
    'reply_zh',
    'reply_en',
    'tokens',
    'targets_used',
    'suggested_replies',
    'goal_progress',
  ],
} as const;

/** Same approach as TURN_RESPONSE_JSON_SCHEMA above, for SentenceGenResponse
 * (POST /v1/sentences — phase doc 04 §1). */
export const SENTENCE_GEN_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          zh: { type: 'string' },
          en: { type: 'string' },
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
        },
        required: ['zh', 'en', 'tokens'],
      },
    },
  },
  required: ['sentences'],
} as const;

const ITEM_REF_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['word', 'grammar'] }, id: { type: 'string' } },
  required: ['kind', 'id'],
} as const;

const SPAN_SCHEMA = {
  type: 'array',
  items: { type: 'integer' },
  minItems: 2,
  maxItems: 2,
} as const;

/** One fully corrected sentence (Phase 17 Part A). No offsets: code finds each
 * edit by searching for contextBefore + before. */
const MODEL_SENTENCE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer' },
    corrected: { type: 'string' },
    natural: { type: 'string' },
    en: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          before: { type: 'string' },
          after: { type: 'string' },
          contextBefore: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'missing_word',
              'extra_word',
              'wrong_word',
              'word_order',
              'mainland_style',
              'measure_word',
              'particle',
              'other',
            ],
          },
          pattern: { type: 'string' },
          itemRef: ITEM_REF_SCHEMA,
          explanationEn: { type: 'string' },
        },
        required: ['before', 'after', 'contextBefore', 'kind', 'explanationEn'],
      },
    },
  },
  required: ['index', 'corrected', 'en', 'edits'],
} as const;

/** JournalReview (POST /v1/journal-review — phase doc 05 §3). */
export const JOURNAL_REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          span: SPAN_SCHEMA,
          type: { type: 'string', enum: ['error', 'unnatural', 'mainland_style'] },
          pattern: { type: 'string' },
          itemRef: ITEM_REF_SCHEMA,
          correction: { type: 'string' },
          explanationEn: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['span', 'type', 'correction', 'explanationEn', 'confidence'],
      },
    },
    natural_rewrite: { type: 'string' },
    brackets: {
      type: 'array',
      items: {
        type: 'object',
        properties: { en: { type: 'string' }, zh: { type: 'string' }, wordId: { type: 'string' } },
        required: ['en', 'zh'],
      },
    },
    used_well: {
      type: 'array',
      items: {
        type: 'object',
        properties: { itemRef: ITEM_REF_SCHEMA, span: SPAN_SCHEMA },
        required: ['itemRef', 'span'],
      },
    },
    sentences: { type: 'array', items: MODEL_SENTENCE_REVIEW_SCHEMA },
  },
  required: ['issues', 'natural_rewrite', 'brackets', 'used_well'],
} as const;

/** JournalCheckResponse (POST /v1/journal-check). */
export const JOURNAL_CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: { acceptable: { type: 'boolean' }, noteEn: { type: 'string' } },
  required: ['acceptable', 'noteEn'],
} as const;

/** JournalExplainResponse (POST /v1/journal-explain). */
export const JOURNAL_EXPLAIN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    explanationEn: { type: 'string' },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: { zh: { type: 'string' }, en: { type: 'string' } },
        required: ['zh', 'en'],
      },
    },
  },
  required: ['explanationEn', 'examples'],
} as const;

/** GlossAdjudicationResponse (POST /v1/gloss — phase doc 07 §B2). */
export const GLOSS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    senses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          glossEn: { type: 'string' },
          noteEn: { type: 'string' },
          register: { type: 'string' },
          taiwanOnly: { type: 'boolean' },
          basedOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'glossEn', 'basedOn'],
      },
    },
    primarySenseId: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['senses', 'primarySenseId', 'confidence'],
} as const;

/** DefineResponse (POST /v1/define). */
export const DEFINE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    pinyin: { type: 'string' },
    glossEn: { type: 'string' },
    noteEn: { type: 'string' },
  },
  required: ['pinyin', 'glossEn'],
} as const;

/** ClozeCheckResponse (POST /v1/cloze-check — phase doc 16 Part B). */
export const CLOZE_CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['ok'],
} as const;

/** Phase 17: POST /v1/journal-sentence-fix returns one sentence review. */
export const JOURNAL_SENTENCE_FIX_JSON_SCHEMA = MODEL_SENTENCE_REVIEW_SCHEMA;

/** Phase 17: POST /v1/journal-verify. */
export const JOURNAL_VERIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problem: { type: 'string' },
    meaningMatches: { type: 'boolean' },
  },
  required: ['ok', 'problem', 'meaningMatches'],
} as const;

/** Phase 17: POST /v1/journal-solve. */
export const JOURNAL_SOLVE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answers: { type: 'array', items: { type: 'string' } },
    confident: { type: 'boolean' },
  },
  required: ['answers', 'confident'],
} as const;
