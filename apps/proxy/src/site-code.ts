import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const SITE_CODE_HEADER = 'x-site-code';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison of what was typed against the server's code. */
export function siteCodeMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * The household code (phase 8): deliberately light — one shared word, checked
 * on every sync AND every AI request so strangers can't spend the AI keys. No
 * accounts, hashing at rest or lockouts. The code lives only in the server's
 * environment (SITE_CODE); the web app just sends what was typed.
 */
export function requireSiteCode(expected: string): MiddlewareHandler {
  return async (c, next) => {
    if (!siteCodeMatches(c.req.header(SITE_CODE_HEADER), expected)) {
      return c.json({ error: 'site code required' }, 401);
    }
    await next();
  };
}
