import {
  hashText,
  restoreErrorItem,
  reportErrorItem,
  countReports,
  SOURCE_REPORT_PREFIX,
  type ClozeReport,
  type ClozeReportReason,
  type ErrorItem,
  type ReportSourceKind,
  type SourceReport,
} from '@anan/core';
import { AnanDB } from '../db/schema.js';
import { profileDbName } from '../db/instance.js';
import { PROFILE_IDS } from '../profiles.js';

// Phase 16: reports. A reported ErrorItem keeps its own `status`/`report`
// fields. Any other source (a journal sentence, chat line or bank sentence) is
// excluded by its text and stored as one `settings` row per sentence, so it
// syncs between devices with the tables Phase 8 already merges.

interface StoredReport extends Omit<SourceReport, 'reportedAt'> {
  reportedAt: string;
}

export type SourceState = SourceReport['state'];

const keyFor = (zh: string) => `${SOURCE_REPORT_PREFIX}${hashText(zh)}`;

const fromStored = (r: StoredReport): SourceReport => ({ ...r, reportedAt: new Date(r.reportedAt) });

export async function loadSourceReports(db: AnanDB): Promise<SourceReport[]> {
  const rows = await db.settings
    .where('key')
    .startsWith(SOURCE_REPORT_PREFIX)
    .toArray();
  return rows.map((r) => fromStored(r.value as StoredReport));
}

/** Sentences that must never be a cloze source again (reported or deleted). */
export async function excludedZh(db: AnanDB): Promise<Set<string>> {
  const all = await loadSourceReports(db);
  return new Set(all.filter((r) => r.state === 'reported' || r.state === 'deleted').map((r) => r.zh));
}

export async function reportSource(
  db: AnanDB,
  src: { zh: string; sourceKind: ReportSourceKind; sourceLabel: string },
  report: { reason: ClozeReportReason; note?: string; profileId: string },
  at: Date,
): Promise<void> {
  const value: StoredReport = {
    ...src,
    reason: report.reason,
    note: report.note || undefined,
    profileId: report.profileId,
    reportedAt: at.toISOString(),
    state: 'reported',
  };
  await db.settings.put({ key: keyFor(src.zh), value });
}

async function setState(db: AnanDB, zh: string, state: SourceState): Promise<void> {
  const row = await db.settings.get(keyFor(zh));
  if (!row) return;
  await db.settings.put({ key: row.key, value: { ...(row.value as StoredReport), state } });
}

/** "It was fine" / the Undo link. */
export const restoreSource = (db: AnanDB, zh: string) => setState(db, zh, 'restored');
/** "Delete": the sentence stays excluded for good. */
export const deleteSource = (db: AnanDB, zh: string) => setState(db, zh, 'deleted');

export async function reportJournalItem(
  db: AnanDB,
  item: ErrorItem,
  report: { reason: ClozeReportReason; note?: string; profileId: string },
  at: Date,
): Promise<void> {
  const full: ClozeReport = {
    reason: report.reason,
    note: report.note || undefined,
    profileId: report.profileId,
    reportedAt: at,
  };
  await db.errorItems.put(reportErrorItem(item, full));
}

export async function restoreJournalItem(db: AnanDB, item: ErrorItem): Promise<void> {
  await db.errorItems.put(restoreErrorItem(item));
}

/** Delete for good: the row stays as `deleted` so a sync can't bring it back,
 * but it leaves the error bank (pattern counts ignore it). */
export async function deleteJournalItem(db: AnanDB, item: ErrorItem): Promise<void> {
  await db.errorItems.put({ ...item, status: 'deleted' });
}

/** Dev metric: how many reports there are, by source and reason. */
export async function reportCounts(db: AnanDB): Promise<Record<string, number>> {
  const items = await db.errorItems.filter((i) => i.status === 'reported').toArray();
  const sources = await loadSourceReports(db);
  return countReports([
    ...items.map((i) => ({ sourceKind: 'journal-item' as const, reason: i.report!.reason })),
    ...sources.map((s) => ({ sourceKind: s.sourceKind, reason: s.reason })),
  ]);
}

/** A sentence-bank sentence is shared content, so a report on it holds for
 * every profile on this device: the same write is made in the other
 * profiles' databases too (best effort — an unopenable one is skipped). */
export async function alsoInOtherProfiles(
  kind: ReportSourceKind,
  currentProfileId: string,
  write: (db: AnanDB) => Promise<void>,
): Promise<void> {
  if (kind !== 'bank') return;
  for (const id of PROFILE_IDS) {
    if (id === currentProfileId) continue;
    const other = new AnanDB(profileDbName(id));
    try {
      await write(other);
    } catch {
      /* the other profile picks nothing up this time */
    } finally {
      other.close();
    }
  }
}
