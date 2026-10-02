import { type Backup, BackupSchema } from './backup-schema.js';
import { type AnanDB, DB_SCHEMA_VERSION, itemPk } from './schema.js';

export async function exportBackup(db: AnanDB, lexiconVersion?: string): Promise<Backup> {
  const [
    items,
    evidence,
    settings,
    meta,
    customWords,
    journalEntries,
    journalReviews,
    errorItems,
    conversations,
    turns,
    rewardEvents,
    glossReports,
    aiGlosses,
  ] = await Promise.all([
    db.items.toArray(),
    db.evidence.toArray(),
    db.settings.toArray(),
    db.meta.toArray(),
    db.customWords.toArray(),
    db.journalEntries.toArray(),
    db.journalReviews.toArray(),
    db.errorItems.toArray(),
    db.conversations.toArray(),
    db.turns.toArray(),
    db.rewardEvents.toArray(),
    db.glossReports.toArray(),
    db.aiGlosses.toArray(),
  ]);
  return {
    schemaVersion: DB_SCHEMA_VERSION,
    lexiconVersion,
    exportedAt: new Date().toISOString(),
    items: items.map(({ pk: _pk, ...rest }) => rest),
    evidence: evidence.map(({ id: _id, ...rest }) => rest),
    settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
    meta: Object.fromEntries(meta.map((m) => [m.key, m.value])),
    customWords,
    journalEntries,
    journalReviews,
    errorItems,
    conversations,
    turns,
    rewardEvents,
    glossReports,
    aiGlosses,
  };
}

export class BackupSchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `Backup schema v${found} is newer than this app supports (v${supported}). Update the app before importing.`,
    );
    this.name = 'BackupSchemaTooNewError';
  }
}

/** Validates `raw` (zod — refuses anything malformed), refuses a newer
 * schema version than this app understands, then wipes and replaces every
 * table inside one transaction (so a failed import can't half-apply). */
export async function importBackup(
  db: AnanDB,
  raw: unknown,
): Promise<{ itemCount: number; evidenceCount: number }> {
  const parsed = BackupSchema.parse(raw);
  if (parsed.schemaVersion > DB_SCHEMA_VERSION) {
    throw new BackupSchemaTooNewError(parsed.schemaVersion, DB_SCHEMA_VERSION);
  }

  const tables = [
    db.items,
    db.evidence,
    db.settings,
    db.meta,
    db.customWords,
    db.journalEntries,
    db.journalReviews,
    db.errorItems,
    db.conversations,
    db.turns,
    db.rewardEvents,
    db.glossReports,
    db.aiGlosses,
  ];
  await db.transaction('rw', tables, async () => {
    await Promise.all([
      db.items.clear(),
      db.evidence.clear(),
      db.settings.clear(),
      db.meta.clear(),
      db.customWords.clear(),
      db.journalEntries.clear(),
      db.journalReviews.clear(),
      db.errorItems.clear(),
      db.conversations.clear(),
      db.turns.clear(),
      db.rewardEvents.clear(),
      db.glossReports.clear(),
      db.aiGlosses.clear(),
    ]);
    if (parsed.items.length > 0) {
      await db.items.bulkPut(parsed.items.map((c) => ({ ...c, pk: itemPk(c.item, c.skill) })));
    }
    if (parsed.evidence.length > 0) {
      await db.evidence.bulkAdd(parsed.evidence);
    }
    const settingsRows = Object.entries(parsed.settings).map(([key, value]) => ({ key, value }));
    if (settingsRows.length > 0) await db.settings.bulkPut(settingsRows);
    const metaRows = Object.entries(parsed.meta).map(([key, value]) => ({ key, value }));
    if (metaRows.length > 0) await db.meta.bulkPut(metaRows);
    if (parsed.customWords.length > 0) await db.customWords.bulkPut(parsed.customWords);
    if (parsed.journalEntries.length > 0) await db.journalEntries.bulkPut(parsed.journalEntries);
    if (parsed.journalReviews.length > 0) await db.journalReviews.bulkPut(parsed.journalReviews);
    if (parsed.errorItems.length > 0) await db.errorItems.bulkPut(parsed.errorItems);
    if (parsed.conversations.length > 0) await db.conversations.bulkPut(parsed.conversations);
    if (parsed.turns.length > 0) await db.turns.bulkPut(parsed.turns);
    if (parsed.rewardEvents.length > 0) await db.rewardEvents.bulkPut(parsed.rewardEvents);
    if (parsed.glossReports.length > 0) await db.glossReports.bulkPut(parsed.glossReports);
    if (parsed.aiGlosses.length > 0) await db.aiGlosses.bulkPut(parsed.aiGlosses);
  });

  return { itemCount: parsed.items.length, evidenceCount: parsed.evidence.length };
}
