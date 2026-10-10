import { z } from 'zod';

// Model names per task come from env config, not code (CLAUDE.md §1).
const EnvSchema = z.object({
  /** Phase 25: Gemini only (free tier). The server refuses to start without it. */
  GEMINI_API_KEY: z.string().optional(),
  /** Phase 33: a comma list of models per role, tried in order (models out of free quota are
   * skipped). The free tier counts requests per model per day, so roles start on different models.
   * Unset: DEFAULT_CHAINS. */
  GEMINI_CHAIN_TURN: z.string().optional(),
  GEMINI_CHAIN_JOURNAL: z.string().optional(),
  /** The story writer (and sentence repair). */
  GEMINI_CHAIN_STORY: z.string().optional(),
  /** The independent checker (journal verify, story check, naturalness): always a fresh call. */
  GEMINI_CHAIN_CHECK: z.string().optional(),
  /** The last link of every chain (when not already in it). */
  GEMINI_MODEL_FALLBACK: z.string().optional(),
  /** Before Phase 33: one model per role. The proxy no longer reads these (it says so at startup);
   * the scripts read GEMINI_MODEL_CHECK as a one-model override, like `--model`. */
  GEMINI_MODEL_TURN: z.string().optional(),
  GEMINI_MODEL_JOURNAL: z.string().optional(),
  GEMINI_MODEL_STORY: z.string().optional(),
  GEMINI_MODEL_CHECK: z.string().optional(),
  /** Known daily request limits, "gemini-2.5-flash=20,…" (see https://ai.dev/rate-limit). A limit
   * in a 429 is learned too. */
  GEMINI_DAILY_LIMITS: z.string().optional(),
  /** Share of a known daily limit that batch scripts leave for the live app. */
  GEMINI_BATCH_RESERVE_SHARE: z.coerce.number().min(0).max(1).default(0.3),
  /** …and at least this many calls. */
  GEMINI_BATCH_RESERVE_MIN: z.coerce.number().int().nonnegative().default(5),
  /** Where the quota tracker keeps its state (default apps/proxy/quota-data/quota.json). */
  QUOTA_FILE: z.string().optional(),
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

export type Role = 'turn' | 'journal' | 'story' | 'check';
export const ROLES: readonly Role[] = ['turn', 'journal', 'story', 'check'];

/**
 * Phase 33 defaults. Three free-tier models, four roles: the writer and the checker never start on
 * the same model; chat and journal (both live, light) share the large-quota lite model. The story
 * writer keeps the stronger model (Phase 26) and falls back to the lite ones.
 */
export const DEFAULT_CHAINS: Record<Role, readonly string[]> = {
  turn: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  journal: ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  story: ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
  check: ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'],
};

const list = (text: string | undefined) =>
  (text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Each role's model chain: GEMINI_CHAIN_<ROLE> or the default, then GEMINI_MODEL_FALLBACK. */
export function resolveChains(env: Env): Record<Role, string[]> {
  const raw: Record<Role, string | undefined> = {
    turn: env.GEMINI_CHAIN_TURN,
    journal: env.GEMINI_CHAIN_JOURNAL,
    story: env.GEMINI_CHAIN_STORY,
    check: env.GEMINI_CHAIN_CHECK,
  };
  const out = {} as Record<Role, string[]>;
  for (const role of ROLES) {
    const chain = list(raw[role]);
    const base = chain.length > 0 ? chain : [...DEFAULT_CHAINS[role]];
    const fb = env.GEMINI_MODEL_FALLBACK?.trim();
    out[role] = [...new Set(fb ? [...base, fb] : base)];
  }
  return out;
}

/** Old one-model settings that are set but no longer read by the proxy (logged at startup). */
export function ignoredLegacyModels(env: Env): string[] {
  return (['GEMINI_MODEL_TURN', 'GEMINI_MODEL_JOURNAL', 'GEMINI_MODEL_STORY', 'GEMINI_MODEL_CHECK'] as const).filter(
    (k) => env[k] !== undefined,
  );
}
