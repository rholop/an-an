import { type AnanDB, itemPk } from './schema.js';

/**
 * Applies a Phase-1 ID-migration map (data/build/id-migration-map.json:
 * old id -> new id) to every saved item and evidence row, so a rebuilt
 * lexicon that merged/renamed entries doesn't orphan a learner's progress.
 * No-ops instantly for an empty map (the common case before any migration
 * has ever been needed).
 */
export async function migrateLexiconIds(db: AnanDB, idMigrationMap: Record<string, string>): Promise<number> {
  if (Object.keys(idMigrationMap).length === 0) return 0;
  let changed = 0;

  await db.transaction('rw', db.items, db.evidence, async () => {
    const items = await db.items.toArray();
    for (const row of items) {
      const newId = idMigrationMap[row.item.id];
      if (!newId || newId === row.item.id) continue;
      const newItem = { ...row.item, id: newId };
      await db.items.delete(row.pk);
      await db.items.put({ ...row, item: newItem, pk: itemPk(newItem, row.skill) });
      changed++;
    }

    const evidence = await db.evidence.toArray();
    for (const row of evidence) {
      const newId = idMigrationMap[row.item.id];
      if (!newId || newId === row.item.id || row.id === undefined) continue;
      await db.evidence.update(row.id, { item: { ...row.item, id: newId } });
    }
  });

  return changed;
}
