import { profileById } from '../profiles.js';
import { currentSession } from '../db/instance.js';
import type { AnanDB } from '../db/schema.js';

export const PROTECTED_TERMS_KEY = 'protectedTerms';

/** Phase 17: the learner's own names (and people they write about often). The
 * model never changes them and they are never a blank. Stored per profile; until
 * the learner edits the list it is just the profile's own name. */
export async function getProtectedTerms(db: AnanDB): Promise<string[]> {
  const row = await db.settings.get(PROTECTED_TERMS_KEY);
  if (Array.isArray(row?.value))
    return (row!.value as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  const id = currentSession()?.profileId;
  return id ? [profileById(id).name] : [];
}

/** "羅恩, 小安" / "羅恩、小安" -> ['羅恩', '小安'] (short, de-duplicated). */
export function parseProtectedTerms(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,，、\n]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 20),
    ),
  ].slice(0, 20);
}
