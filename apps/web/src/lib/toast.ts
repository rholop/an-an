import { useSyncExternalStore } from 'react';

/**
 * Phase 21 Part H: one confirmation toast for the whole app (a report sent, a word removed …), with
 * an optional Undo. A success is never shown as an error line any more.
 */
export interface Toast {
  id: number;
  text: string;
  undo?: () => Promise<void> | void;
}

let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(text: string, undo?: () => Promise<void> | void, ms = 6000): void {
  clearTimeout(timer);
  current = { id: ++seq, text, ...(undo ? { undo } : {}) };
  emit();
  timer = setTimeout(hideToast, ms);
}

export function hideToast(): void {
  clearTimeout(timer);
  current = null;
  emit();
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
