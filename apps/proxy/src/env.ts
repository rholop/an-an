import { z } from 'zod';

// Model names per task come from env config, not code (CLAUDE.md §1).
const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_MODEL_TURN: z.string().default('gemini-1.5-flash'),
  OPENAI_MODEL_TURN: z.string().default('gpt-4o-mini'),
  CORS_ORIGIN: z.string().default('http://localhost:5183'),
  /** Requests per client (install-id header) per minute. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Tokens per client per UTC calendar day. */
  DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  PORT: z.coerce.number().int().positive().default(3002),
  PROMPT_VERSION: z.string().default('v1'),
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
