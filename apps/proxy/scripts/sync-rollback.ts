/**
 * Roll a profile back to one of its last 10 saved versions (phase 8). Not an
 * HTTP endpoint on purpose: a rollback is an owner action on the server.
 *
 *   pnpm --filter @anan/proxy sync-rollback ron            # list versions
 *   pnpm --filter @anan/proxy sync-rollback ron 7          # make rev 7 the newest version
 *
 * The old version is written as a NEW revision (rev N+1), so devices that last
 * synced at a lower rev see it as a normal update and merge it in — and
 * because merging never deletes records, a rollback undoes in-place changes
 * (cards, settings) but cannot remove records that devices already hold.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProfileId } from '@anan/core';
import { loadEnv } from '../src/env.js';
import { FileSyncStore } from '../src/sync-store.js';

const [profileId, revArg] = process.argv.slice(2);
if (!profileId || !isProfileId(profileId)) {
  console.error('usage: sync-rollback <profileId> [rev]');
  process.exit(1);
}
const env = loadEnv();
const dir =
  env.SYNC_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sync-data');
const store = new FileSyncStore(dir);

const versions = await store.versions(profileId);
if (!revArg) {
  console.log(
    versions.length === 0
      ? 'no versions saved'
      : versions.map((v) => `rev ${v.rev}  ${v.updatedAt}`).join('\n'),
  );
  process.exit(0);
}
const target = await store.getVersion(profileId, Number(revArg));
const current = await store.get(profileId);
if (!target || !current) {
  console.error(
    `rev ${revArg} is not among the saved versions (${versions.map((v) => v.rev).join(', ')})`,
  );
  process.exit(1);
}
const result = await store.put(profileId, target.blob, current.rev);
console.log(
  result.ok
    ? `rolled ${profileId} back to rev ${revArg}; it is now rev ${result.rev}`
    : 'someone saved while rolling back — try again',
);
