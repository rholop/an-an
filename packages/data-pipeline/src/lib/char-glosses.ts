import { readFileSync, writeFileSync } from 'node:fs';
import { shortCharGloss } from '@anan/core';

/**
 * Phase 44: the Unihan per-character glosses the review card shows, shortened here (never in the
 * browser) to their first one or two senses, about 30 characters, no trigram/hexagram notes.
 * Characters left with nothing are dropped.
 */
export function briefCharGlosses(full: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ch of Object.keys(full).sort()) {
    const brief = shortCharGloss(full[ch]);
    if (brief) out[ch] = brief;
  }
  return out;
}

/** `char-glosses.v1.json` (full Unihan) → `char-glosses.brief.v1.json` (what the app ships). */
export function writeBriefCharGlosses(fullPath: string, briefPath: string): number {
  const brief = briefCharGlosses(JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, string>);
  writeFileSync(briefPath, JSON.stringify(brief, null, 2) + '\n', 'utf8');
  return Object.keys(brief).length;
}
