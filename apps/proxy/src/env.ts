import { z } from 'zod';

// Model names per task come from env config, not code (CLAUDE.md §1).
const EnvSchema = z.object({
  /** Phase 25: Gemini only (free tier). The server refuses to start without it. */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_TURN: z.string().default('gemini-3.5-flash-lite'),
  // Journal review/check/explain (Phase 5), stories, glosses: can use a stronger model than chat.
  GEMINI_MODEL_JOURNAL: z.string().default('gemini-3.5-flash-lite'),
  /** A DIFFERENT free-tier Gemini model, tried once after the task model fails twice. */
  GEMINI_MODEL_FALLBACK: z.string().default('gemini-2.5-flash'),
  /** Phase 26: the story writer. Following a 250-word list is the hardest instruction-following job
   * in the app, so it defaults to the stronger free-tier model. */
  GEMINI_MODEL_STORY: z.string().default('gemini-2.5-flash'),
  /** The independent checker (journal verify, story check): a fresh call, the stronger free model. */
  GEMINI_MODEL_CHECK: z.string().default('gemini-2.5-flash'),
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
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed once at startup; a missing/invalid required var fails fast rather
 * than producing confusing runtime errors later. The API key is optional here so
 * tests can load an env; server.ts refuses to start without it. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
