import { useState, type ReactNode } from 'react';
import './InfoTip.css';

/**
 * Phase 30: a note that would cost a line of height, behind a small ⓘ (shown on hover or tap).
 * The text stays in the page for screen readers and tests.
 */
export function InfoTip({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`info-tip${open ? ' info-tip--open' : ''}`}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⓘ
      </button>
      <span className="info-tip-text" role="note" data-testid={testId}>
        {children}
      </span>
    </span>
  );
}
