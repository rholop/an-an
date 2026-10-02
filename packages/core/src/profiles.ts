/**
 * The household's profiles — FIXED config, not user-created (phase 8). Adding
 * a third person means adding one line here; nothing else needs to change
 * (the web app, the sync server and its tests all read this list).
 *
 * Ids are ASCII (database names, URLs, headers); `name` is what people see.
 * apps/web/src/profiles.ts re-exports this for the web app.
 */
export const PROFILES = [
  { id: 'ron', name: '羅恩' },
  { id: 'guanyu', name: '冠宇' },
] as const;

export type ProfileId = (typeof PROFILES)[number]['id'];
export type Profile = (typeof PROFILES)[number];

export const PROFILE_IDS: readonly ProfileId[] = PROFILES.map((p) => p.id);

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value);
}

export function profileById(id: ProfileId): Profile {
  return PROFILES.find((p) => p.id === id)!;
}
