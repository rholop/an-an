import { useSyncExternalStore } from 'react';

/**
 * iOS keeps the layout viewport the same size when the on-screen keyboard opens;
 * only the VISUAL viewport shrinks (and may be scrolled). So anything that must
 * stay above the keyboard (chat and journal inputs) sizes itself from these
 * variables, set on <html>:
 *
 *   --vvh     height of the visible area, px   (use instead of 100vh / 100dvh)
 *   --vv-top  how far that area is scrolled from the top of the layout viewport
 *   html.kb-open  the keyboard is up (the tab bar steps aside)
 *
 * Without `visualViewport` (old browsers, tests) nothing is set and the CSS
 * falls back to 100dvh.
 */
const KEYBOARD_MIN_PX = 120;

let keyboardOpen = false;
const listeners = new Set<() => void>();

export function installViewportTracking(): () => void {
  const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
  if (!vv) return () => undefined;
  const root = document.documentElement;
  const update = () => {
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
    const open = window.innerHeight - vv.height > KEYBOARD_MIN_PX;
    root.classList.toggle('kb-open', open);
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      listeners.forEach((l) => l());
    }
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    root.style.removeProperty('--vvh');
    root.style.removeProperty('--vv-top');
    root.classList.remove('kb-open');
  };
}

/** True while the on-screen keyboard is up. */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => keyboardOpen,
    () => false,
  );
}
