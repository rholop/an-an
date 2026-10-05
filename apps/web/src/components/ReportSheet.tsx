import { useState } from 'react';
import { CLOZE_REPORT_REASONS, type ClozeReportReason } from '@anan/core';
import './ReportSheet.css';

/** Phase 16 Part C: the "Something's wrong" button on every cloze card and
 * the sheet it opens. One tap on a reason sends the report (with whatever is
 * in the optional note). */
export function ReportButton({
  onReport,
}: {
  onReport: (reason: ClozeReportReason, note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  return (
    <>
      <button
        type="button"
        className="report-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">⚑</span> Something&apos;s wrong
      </button>
      {open && (
        <div className="report-backdrop" onClick={() => setOpen(false)}>
          <div
            className="report-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="What's wrong with this card?"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>What&apos;s wrong with this card?</h2>
            <label className="report-note">
              Note (optional)
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={300}
              />
            </label>
            <div className="report-reasons">
              {CLOZE_REPORT_REASONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onReport(r.id, note.trim());
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button type="button" className="report-cancel" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** "Thanks, this one won't come back." with an Undo link for a few seconds. */
export function ReportNotice({ onUndo, onGone }: { onUndo: () => void; onGone: () => void }) {
  return (
    <div className="report-notice" role="status">
      Thanks, this one won&apos;t come back.{' '}
      <button type="button" className="report-undo" onClick={onUndo}>
        Undo
      </button>
      <button type="button" className="report-dismiss" onClick={onGone} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
