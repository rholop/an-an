import { useEffect } from 'react';

/**
 * Phase 28: push progress to the server at the end of every session (Review, lesson study, Water
 * all, Cloze, Listen, Pinyin & tones, a journal save, a story finished) instead of waiting for the
 * quiet period. The profile controller registers the open profile's sync here.
 */
let saver: (() => Promise<void>) | null = null;

export function setProgressSaver(fn: (() => Promise<void>) | null): void {
  saver = fn;
}

/** Push now (never throws; offline is handled by the sync's own retry). */
export function saveProgressNow(): void {
  void saver?.().catch(() => undefined);
}

/** Push once each time `done` becomes true (a session's end screen). */
export function useSaveWhenDone(done: boolean): void {
  useEffect(() => {
    if (done) saveProgressNow();
  }, [done]);
}
