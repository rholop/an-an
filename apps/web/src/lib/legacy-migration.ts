import Dexie from 'dexie';
import { applyMergedBackup, exportBackup } from '../db/backup.js';
import { mergeBackups } from '../db/merge.js';
import { AnanDB } from '../db/schema.js';

/** The pre-profiles single database. */
export const LEGACY_DB_NAME = 'anan';

export async function legacyDbExists(): Promise<boolean> {
  try {
    return await Dexie.exists(LEGACY_DB_NAME);
  } catch {
    return false;
  }
}

export interface LegacyMigrationResult {
  items: number;
  evidence: number;
}

export class LegacyMigrationError extends Error {}

/**
 * Phase 8 §3: copy the old single database into `target` (a profile's
 * database), then delete the old one. It is never discarded silently: the old
 * database is only deleted after the copy has been VERIFIED (every item and
 * every evidence row is present in the target); on any failure it is left
 * untouched so the question can simply be asked again.
 *
 * The copy is a merge, not an overwrite, so if the chosen profile already has
 * data (e.g. pulled from the server first) nothing in it is lost either.
 */
export async function migrateLegacyInto(target: AnanDB): Promise<LegacyMigrationResult> {
  const legacy = new AnanDB(LEGACY_DB_NAME); // opening upgrades it to the current schema (uids, updatedAt)
  try {
    const old = await exportBackup(legacy);
    const mine = await exportBackup(target);
    const merged = mergeBackups(mine, old);
    await applyMergedBackup(target, merged);

    const [itemCount, evidenceCount] = await Promise.all([
      target.items.count(),
      target.evidence.count(),
    ]);
    const wantedItems = new Set(old.items.map((c) => `${c.item.kind}:${c.item.id}:${c.skill}`));
    const haveItems = new Set(
      (await target.items.toArray()).map((c) => `${c.item.kind}:${c.item.id}:${c.skill}`),
    );
    const missing = [...wantedItems].filter((k) => !haveItems.has(k));
    if (missing.length > 0 || evidenceCount < old.evidence.length) {
      throw new LegacyMigrationError(
        `Copy check failed (${missing.length} items missing, ${evidenceCount}/${old.evidence.length} evidence rows) — your old data was kept.`,
      );
    }
    legacy.close();
    await Dexie.delete(LEGACY_DB_NAME);
    return { items: itemCount, evidence: evidenceCount };
  } finally {
    legacy.close();
  }
}
