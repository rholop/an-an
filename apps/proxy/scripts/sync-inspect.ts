/**
 * Phase 28: what the server holds for each profile, so the owner can see which saved version has
 * their progress. Read-only.
 *
 *   pnpm --filter @anan/proxy sync:inspect            # every profile
 *   pnpm --filter @anan/proxy sync:inspect ron        # one profile
 *
 * Each line: rev, when it was saved, its size, cards met, Learned, Mastered, evidence records and the
 * newest evidence time (the same counts Settings → Your progress shows).
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isProfileId, summarizeSavedCopy } from '@anan/core';
import { loadEnv } from '../src/env.js';
import { FileSyncStore } from '../src/sync-store.js';

const only = process.argv[2];
// The same SYNC_DIR the server uses: apps/proxy/.env (real environment variables win).
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = loadEnv();
const dir = env.SYNC_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sync-data');
const store = new FileSyncStore(dir);

let profiles: string[];
try {
  profiles = readdirSync(dir).filter(isProfileId);
} catch {
  profiles = [];
}
if (only) profiles = profiles.filter((p) => p === only);
console.log(`SYNC_DIR ${dir}`);
if (profiles.length === 0) console.log(only ? `no saved copy for ${only}` : 'no saved copies');

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
for (const id of profiles) {
  console.log(`\n${id}`);
  const versions = await store.versions(id);
  for (const v of [...versions].reverse()) {
    const rec = await store.getVersion(id, v.rev);
    if (!rec) continue;
    const text = gunzipSync(rec.blob).toString('utf8');
    const s = summarizeSavedCopy(JSON.parse(text));
    console.log(
      `  rev ${String(v.rev).padStart(4)}  ${v.updatedAt}  ${kb(Buffer.byteLength(text)).padStart(8)} (${kb(rec.blob.length)} stored)` +
        `  ${s.cards} cards · ${s.learned} Learned · ${s.mastered} Mastered · ${s.evidence} evidence · last ${s.lastEvidenceAt ?? 'never'}`,
    );
  }
}
