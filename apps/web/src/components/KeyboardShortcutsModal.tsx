import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './KeyboardShortcutsModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="shortcuts-backdrop"
      onClick={onClose}
      data-testid="shortcuts-modal-backdrop"
    >
      <div
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        data-testid="shortcuts-modal"
      >
        <div className="shortcuts-header">
          <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
          <button
            type="button"
            className="shortcuts-close"
            onClick={onClose}
            aria-label="Close shortcuts"
          >
            ×
          </button>
        </div>

        <div className="shortcuts-body">
          <div className="shortcuts-section">
            <h3 className="shortcuts-section-title">Study & Review Sessions</h3>
            <div className="shortcuts-list">
              <div className="shortcuts-row">
                <span className="shortcuts-label">Show answer / Next card</span>
                <span className="shortcuts-keys">
                  <kbd>Space</kbd> or <kbd>Enter</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Submit / Check typed answer</span>
                <span className="shortcuts-keys">
                  <kbd>Enter</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Review ratings: Again, Hard, Good, Easy</span>
                <span className="shortcuts-keys">
                  <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Select multiple choice option</span>
                <span className="shortcuts-keys">
                  <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Play / Replay audio</span>
                <span className="shortcuts-keys">
                  <kbd>P</kbd> or <kbd>R</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Undo last answer</span>
                <span className="shortcuts-keys">
                  <kbd>Z</kbd>
                </span>
              </div>
            </div>
          </div>

          <div className="shortcuts-section">
            <h3 className="shortcuts-section-title">Navigation & Tools</h3>
            <div className="shortcuts-list">
              <div className="shortcuts-row">
                <span className="shortcuts-label">Toggle / Focus level picker</span>
                <span className="shortcuts-keys">
                  <kbd>L</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Show keyboard shortcuts</span>
                <span className="shortcuts-keys">
                  <kbd>?</kbd>
                </span>
              </div>
              <div className="shortcuts-row">
                <span className="shortcuts-label">Close dialog / Cancel</span>
                <span className="shortcuts-keys">
                  <kbd>Esc</kbd>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="shortcuts-footer">
          Press <kbd>?</kbd> anytime to open this cheatsheet.
        </div>
      </div>
    </div>,
    document.body,
  );
}
