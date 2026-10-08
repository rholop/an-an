import { z } from 'zod';

// Model names per task come from env config, not code (CLAUDE.md §1).
const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_MODEL_TURN: z.string().default('gemini-3.5-flash-lite'),
  OPENAI_MODEL_TURN: z.string().default('gpt-4o-mini'),
  // Journal review/check/explain (Phase 5) can use a stronger model than chat.
  GEMINI_MODEL_JOURNAL: z.string().default('gemini-3.5-flash-lite'),
  OPENAI_MODEL_JOURNAL: z.string().default('gpt-4o-mini'),
  CORS_ORIGIN: z.string().default('http://localhost:5183'),
  /** Requests per client (install-id header) per minute. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Tokens per client per UTC calendar day. */
  DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  PORT: z.coerce.number().int().positive().default(3002),
  /** The household code (phase 8) — server-side only, never in the web bundle. */
  SITE_CODE: z.string().min(1).optional(),
  /** Where per-profile saved copies are written (see README "Sync"). */
  SYNC_DIR: z.string().optional(),
  /** Where audio marks are written (phase 10). Default: apps/proxy/audio-data */
  AUDIO_DIR: z.string().optional(),
  /** Phase 12: folder holding data/curriculum/<book>/private/*.json (default: the repo's data/curriculum). */
  TEXTBOOK_DIR: z.string().optional(),
  PROMPT_VERSION: z.string().default('v1'),
  /** Phase 25: OpenAI costs money, so it is never called unless this is set to 1 (Ezra, 2026-10-08).
   * Without it the proxy is Gemini-only, even when OPENAI_API_KEY is present. */
  OPENAI_ENABLED: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed once at startup; a missing/invalid required var fails fast rather
 * than producing confusing runtime errors later. Both API keys are
 * individually optional (so e.g. local dev can test the OpenAI path alone)
 * but main() warns loudly if both are absent — the proxy would 500 on
 * every real request. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
