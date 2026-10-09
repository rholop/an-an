import { useEffect, useState } from 'react';
import type { SyncManager, SyncStatus } from '../lib/sync.js';
import {
  notSavedFor,
  SAVE_NOW,
  SAVE_OUTDATED,
  SAVE_RETRYING,
  SAVE_TOO_LARGE,
  SAVED,
  SAVING,
} from '../lib/labels.js';
import './SaveStatus.css';

/** Unsaved changes younger than this read as "Saving…" (the push waits a few seconds after a change). */
const QUIET_MS = 2 * 60_000;
/** After this long the profile switcher and Settings warn before anything that could lose it. */
export const UNSAVED_WARN_MS = 10 * 60_000;

export type SaveView = 'saved' | 'saving' | 'unsaved';

/** Phase 28: what the cloud shows, from the sync status and since when changes are unsaved. */
export function saveView(status: SyncStatus, unsavedSince: Date | null, now: Date): SaveView {
  if (status === 'synced' && !unsavedSince) return 'saved';
  if (status === 'too_large' || status === 'offline' || status === 'outdated') return 'unsaved';
  if (status === 'saving') return 'saving';
  return unsavedSince && now.getTime() - unsavedSince.getTime() > QUIET_MS ? 'unsaved' : 'saving';
}

/** The reason for an unsaved state, in words. */
export function unsavedReason(sync: SyncManager): string {
  if (sync.status === 'too_large') return SAVE_TOO_LARGE;
  if (sync.status === 'outdated') return SAVE_OUTDATED;
  return SAVE_RETRYING;
}

/** True when changes have been off the server long enough to warn before switching or clearing. */
export function unsavedTooLong(sync: SyncManager | null, now: Date = new Date()): boolean {
  const since = sync?.unsavedSince();
  return !!since && now.getTime() - since.getTime() > UNSAVED_WARN_MS;
}

/** Re-render every half minute so "Not saved for N min" stays true. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const Cloud = () => (
  <svg viewBox="0 0 20 14" width="1.15em" height="0.85em" aria-hidden="true" focusable="false" className="save-cloud">
    <path d="M5.5 13h9a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 4.6 6.1 3.5 3.5 0 0 0 5.5 13z" />
  </svg>
);

/**
 * Phase 28: the header's cloud. "Saved ✓", "Saving…", or "Not saved for 2 h" (warn colour), which
 * opens the reason and a Save now button. Never a dot only.
 */
export function SaveStatus({ sync }: { sync: SyncManager }) {
  const now = useMinuteClock();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const since = sync.unsavedSince();
  const view = saveView(sync.status, since, now);
  if (view !== 'unsaved' && open) setOpen(false);
  if (view === 'saved')
    return (
      <span className="save-status save-status--saved" data-testid="sync-status" data-state="saved" title={SAVED}>
        <Cloud />
        <span aria-hidden="true">✓</span>
        <span className="save-status-text">{SAVED}</span>
      </span>
    );
  if (view === 'saving')
    return (
      <span className="save-status" data-testid="sync-status" data-state="saving" role="status">
        <Cloud />
        <span className="save-status-text">{SAVING}</span>
      </span>
    );
  return (
    <span className="save-status-wrap">
      <button
        type="button"
        className="save-status save-status--unsaved"
        data-testid="sync-dot"
        data-state="unsaved"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Cloud />
        <span className="save-status-text">{notSavedFor(since ?? now, now)}</span>
      </button>
      {open && (
        <span className="save-status-pop" role="alert" data-testid="sync-reason">
          <span>{unsavedReason(sync)}</span>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            data-testid="sync-save-now"
            onClick={async () => {
              setBusy(true);
              try {
                await sync.saveNow();
              } finally {
                setBusy(false);
              }
            }}
          >
            {SAVE_NOW}
          </button>
        </span>
      )}
    </span>
  );
}
