import { useEffect, useState } from 'react';
import { summarizeSavedCopy, type SavedCopySummary } from '@anan/core';
import { db } from '../db/instance.js';
import { useProfile } from './ProfileGate.js';
import { unsavedReason, unsavedTooLong } from './SaveStatus.js';
import {
  copyCounts,
  lastSavedLine,
  SAVE_NOW,
  SAVED_VERSIONS_KEPT,
  savedWhen,
  TERM,
  thisBrowserLine,
  UNSAVED_WARNING,
} from '../lib/labels.js';
import type { SavedVersion } from '../lib/sync.js';

/** This browser's own numbers, counted the same way as a saved copy (so a gap is visible). */
async function browserSummary(): Promise<SavedCopySummary> {
  const [items, studyOrder] = await Promise.all([db.items.toArray(), db.settings.get('studyOrder')]);
  const s = summarizeSavedCopy({ items, settings: { studyOrder: studyOrder?.value } });
  return { ...s, evidence: await db.evidence.count() };
}

/**
 * Phase 28: Settings → Your progress. When it was last saved to the server and what that copy holds,
 * the same numbers for this browser, Save now, and the server's saved versions (Restore merges one
 * in; Replace, after a confirmation, makes it the data here and on the server).
 */
export function YourProgress() {
  const { sync, syncTick } = useProfile();
  const [here, setHere] = useState<SavedCopySummary | null>(null);
  const [versions, setVersions] = useState<SavedVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    void browserSummary().then(setHere).catch(() => undefined);
  }, [syncTick]);

  if (!sync)
    return (
      <section data-testid="your-progress">
        <h2>Your progress</h2>
        <p className="review-settings-muted">This browser keeps progress here only (saving to the server is off).</p>
      </section>
    );
  const saved = sync.savedInfo;
  const failing = sync.status === 'too_large' || sync.status === 'offline' || sync.status === 'outdated';

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setNote('');
    try {
      await fn();
      setNote(label);
    } catch (err) {
      setNote(`That didn't work: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="your-progress">
      <h2>Your progress</h2>
      {unsavedTooLong(sync) && (
        <p className="review-settings-warn" role="alert" data-testid="unsaved-warning">
          {UNSAVED_WARNING} {unsavedReason(sync)}
        </p>
      )}
      <p data-testid="last-saved">{saved ? lastSavedLine(saved) : 'Not saved to the server yet.'}</p>
      {here && <p data-testid="this-browser">{thisBrowserLine(here)}</p>}
      {failing && !unsavedTooLong(sync) && <p className="review-settings-warn">{unsavedReason(sync)}</p>}
      <p>
        <button type="button" disabled={busy} onClick={() => void run('Saved.', () => sync.saveNow())} data-testid="settings-save-now">
          {SAVE_NOW}
        </button>{' '}
        <button
          type="button"
          disabled={busy}
          data-testid="show-versions"
          onClick={() =>
            void run('', async () => {
              setVersions(await sync.versions());
            })
          }
        >
          Saved versions
        </button>
      </p>
      {note && <p role="status">{note}</p>}
      {versions && (
        <ul className="saved-versions" data-testid="saved-versions">
          {versions.length === 0 && <li>No saved versions on the server yet.</li>}
          {versions.length > 0 && <li className="review-settings-muted">{SAVED_VERSIONS_KEPT}</li>}
          {versions.map((v) => (
            <li key={v.rev} data-testid="saved-version">
              <span>
                {savedWhen(v.updatedAt)} · {copyCounts(v)} · {v.mastered} {TERM.mastered}
              </span>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run('Restored: that version is merged into your progress.', () => sync.restoreVersion(v.rev, 'merge'))
                }
              >
                Restore
              </button>{' '}
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Replace all progress here and on the server with the version from ${savedWhen(v.updatedAt)}? Anything newer is lost.`,
                    )
                  )
                    return;
                  void run('Replaced with that version.', () => sync.restoreVersion(v.rev, 'replace'));
                }}
              >
                Replace with this version
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
