// The two household profiles (phase 8). The list itself lives in @anan/core so
// the sync server accepts exactly the same ids; to add a person, add one line to
// packages/core/src/profiles.ts.
export { PROFILES, PROFILE_IDS, isProfileId, profileById } from '@anan/core';
export type { Profile, ProfileId } from '@anan/core';
