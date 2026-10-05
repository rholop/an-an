import type { ClozeReport, ClozeReportReason, ErrorItem } from '../journal/types.js';

export const CLOZE_REPORT_REASONS: readonly { id: ClozeReportReason; label: string }[] = [
  { id: 'garbled', label: "The sentence is garbled / doesn't make sense" },
  { id: 'wrong_answer', label: 'The answer is wrong' },
  { id: 'other_answer_fits', label: 'Another answer also fits' },
  { id: 'blank_misplaced', label: 'The blank is in the wrong place' },
  { id: 'english_wrong', label: 'The English is wrong' },
  { id: 'other', label: 'Something else' },
];

export type ReportSourceKind = 'journal-item' | 'journal' | 'chat' | 'bank';

/** A reported source that isn't an ErrorItem (a journal sentence, chat line
 * or bank sentence). Stored as a settings row (key `clozeReport:<hash>`), so
 * it syncs between devices with no new table. `zh` is what is excluded. */
export interface SourceReport extends ClozeReport {
  zh: string;
  sourceKind: ReportSourceKind;
  sourceLabel: string;
  /** 'restored' = the learner said "It was fine"; 'deleted' = removed for good. */
  state: 'reported' | 'restored' | 'deleted';
}

export const SOURCE_REPORT_PREFIX = 'clozeReport:';

/** Only `active` journal items are shown. */
export const isShowableErrorItem = (i: Pick<ErrorItem, 'status' | 'flagged'>): boolean =>
  i.status === 'active' && !i.flagged;

export function reportErrorItem(item: ErrorItem, report: ClozeReport): ErrorItem {
  return { ...item, status: 'reported', report };
}

/** "It was fine" / the Undo link: back to `active`, report cleared. */
export function restoreErrorItem(item: ErrorItem): ErrorItem {
  const { report: _report, blockedReason: _reason, ...rest } = item;
  return { ...rest, status: 'active' };
}

export function blockErrorItem(item: ErrorItem, reason: string): ErrorItem {
  return { ...item, status: 'blocked', blockedReason: reason };
}

/** Sentences that must never be a cloze source again. */
export function reportedZhSet(reports: readonly SourceReport[]): Set<string> {
  return new Set(
    reports.filter((r) => r.state === 'reported' || r.state === 'deleted').map((r) => r.zh),
  );
}

/** Dev metric: reports counted by source and reason (Phase 5's flag metric). */
export function countReports(
  reports: readonly { sourceKind: ReportSourceKind; reason: ClozeReportReason }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reports) {
    const key = `${r.sourceKind}:${r.reason}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
