import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './BottomSheet.css';

/**
 * A phone bottom sheet: full width, pinned to the bottom of the screen, closes
 * on a tap outside, a swipe down, Escape or the × button. Portalled to <body>
 * so no ancestor (transforms, filters, overflow) can clip or misplace it.
 */
export function BottomSheet({
  label,
  onClose,
  children,
  testId,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const startY = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose} data-testid={testId}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => (startY.current = e.touches[0]?.clientY ?? null)}
        onTouchEnd={(e) => {
          const y = e.changedTouches[0]?.clientY;
          if (startY.current !== null && y !== undefined && y - startY.current > 60) onClose();
          startY.current = null;
        }}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
