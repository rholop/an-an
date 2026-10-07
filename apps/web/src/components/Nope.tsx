import { useState } from 'react';
import type { NopeChoice } from '@anan/core';
import { NOPE_LABELS } from '../lib/nope.js';
import './Nope.css';

/** Phase 20: the one-tap "Nope" next to the answer buttons. Visible before and after revealing. */
export function NopeButton({ onNope, disabled }: { onNope: () => void; disabled?: boolean }) {
  return (
    <button className="nope-btn" onClick={onNope} disabled={disabled} data-testid="nope-btn" title="Take this word out of review">
      Nope
    </button>
  );
}

/** "Removed from review" with Undo and Change (Not now / I already know it / Never show this). */
export function NopeToast({
  word,
  choice,
  onUndo,
  onChange,
  onClose,
}: {
  word: string;
  choice: NopeChoice;
  onUndo: () => void;
  onChange: (choice: NopeChoice) => void;
  onClose: () => void;
}) {
  const [changing, setChanging] = useState(false);
  return (
    <div className="nope-toast" role="status" data-testid="nope-toast">
      <span>
        <span lang="zh-Hant">{word}</span>: removed from review ({NOPE_LABELS[choice]}).
      </span>
      <span className="nope-toast-actions">
        <button onClick={onUndo} data-testid="nope-undo">
          Undo
        </button>
        <button onClick={() => setChanging((c) => !c)} aria-expanded={changing} data-testid="nope-change">
          Change
        </button>
        <button onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      </span>
      {changing && (
        <span className="nope-toast-choices">
          {(Object.keys(NOPE_LABELS) as NopeChoice[]).map((c) => (
            <button
              key={c}
              aria-pressed={c === choice}
              data-testid={`nope-choice-${c}`}
              onClick={() => {
                setChanging(false);
                if (c !== choice) onChange(c);
              }}
            >
              {NOPE_LABELS[c]}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
