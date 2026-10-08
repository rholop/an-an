import { hideToast, useToast } from '../lib/toast.js';
import { UNDO } from '../lib/labels.js';
import './ToastHost.css';

/** Mounted once (App): the app's one confirmation toast. */
export function ToastHost() {
  const toast = useToast();
  if (!toast) return null;
  return (
    <div className="toast" role="status" data-testid="toast">
      <span>{toast.text}</span>
      {toast.undo && (
        <button
          type="button"
          onClick={async () => {
            hideToast();
            await toast.undo!();
          }}
          data-testid="toast-undo"
        >
          {UNDO}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Close" onClick={hideToast}>
        ×
      </button>
    </div>
  );
}
