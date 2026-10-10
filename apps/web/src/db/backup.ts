import { type Backup, BackupSchema } from './backup-schema.js';
import { type AnanDB, DB_SCHEMA_VERSION, itemPk } from './schema.js';

/** `anan-ron-2026-10-02.json` — the profile id is in the file name so two
 * people's exports can never be mixed up (phase 8). */
export function backupFileName(profileId: string, now: Date = new Date()): string {
  return `anan-${profileId}-${now.toISOString().slice(0, 10)}.json`;
}

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
    liveSentences,
    readerShown,
    stories,
    activeDays,
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
    db.liveSentences.toArray(),
    db.readerShown.toArray(),
    db.stories.toArray(),
    db.activeDays.toArray(),
  ]);
  const stamps = (rows: { key: string; updatedAt?: Date }[]) =>
    Object.fromEntries(rows.flatMap((r) => (r.updatedAt ? [[r.key, r.updatedAt] as const] : [])));
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
    liveSentences,
    readerShown,
    stories,
    activeDays,
    settingsUpdatedAt: stamps(settings),
    metaUpdatedAt: stamps(meta),
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

/** Wipes every table and writes `parsed` inside ONE transaction, so a failure
 * can't leave a half-applied copy. Rows are stored exactly as given. */
async function replaceAll(db: AnanDB, parsed: Backup): Promise<void> {
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
    db.liveSentences,
    db.readerShown,
    db.stories,
    db.activeDays,
  ];
  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((t) => t.clear()));
    if (parsed.items.length > 0) {
      await db.items.bulkPut(parsed.items.map((c) => ({ ...c, pk: itemPk(c.item, c.skill) })));
    }
    if (parsed.evidence.length > 0) await db.evidence.bulkAdd(parsed.evidence);
    const keyed = (rec: Record<string, unknown>, stamps: Record<string, Date>) =>
      Object.entries(rec).map(([key, value]) => ({
        key,
        value,
        ...(stamps[key] ? { updatedAt: stamps[key] } : {}),
      }));
    const settingsRows = keyed(parsed.settings, parsed.settingsUpdatedAt);
    if (settingsRows.length > 0) await db.settings.bulkPut(settingsRows);
    const metaRows = keyed(parsed.meta, parsed.metaUpdatedAt);
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
    if (parsed.liveSentences.length > 0) await db.liveSentences.bulkPut(parsed.liveSentences);
    if (parsed.readerShown.length > 0) await db.readerShown.bulkPut(parsed.readerShown);
    if (parsed.stories.length > 0) await db.stories.bulkPut(parsed.stories);
    if (parsed.activeDays.length > 0) await db.activeDays.bulkPut(parsed.activeDays);
  });
  db.forgetMarkedDay();
}

/** A user restore from a file: validates (zod — refuses anything malformed),
 * refuses a newer schema version, then replaces everything. Rows that lack a
 * uid/updatedAt (older backups) get them stamped as a normal local write, and
 * the restore counts as a local change (so it syncs). */
export async function importBackup(
  db: AnanDB,
  raw: unknown,
): Promise<{ itemCount: number; evidenceCount: number }> {
  const parsed = BackupSchema.parse(raw);
  if (parsed.schemaVersion > DB_SCHEMA_VERSION) {
    throw new BackupSchemaTooNewError(parsed.schemaVersion, DB_SCHEMA_VERSION);
  }
  await replaceAll(db, parsed);
  return { itemCount: parsed.items.length, evidenceCount: parsed.evidence.length };
}

/** Writes a sync-merged copy: hooks are off so every row keeps its own uid and
 * updatedAt, and the write isn't mistaken for a new local edit. */
export async function applyMergedBackup(db: AnanDB, merged: Backup): Promise<void> {
  await db.withoutHooks(() => replaceAll(db, merged));
}
