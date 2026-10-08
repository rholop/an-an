import { onSessionChange } from '../db/instance.js';
/**
 * Phase 19: the last few cards answered, across screens and the parts of "Study this lesson", so the
 * next session's order keeps its sibling gap across the boundary (orderSession's `recent`).
 */
const MAX = 12;
/** Older than this, a shown card no longer counts as "just before". */
const TTL_MS = 30 * 60 * 1000;

let shown: Array<{ keys: string[]; at: number }> = [];

// Phase 21: another profile's cards never count as "just shown".
onSessionChange(() => clearRecentShown());

export function noteShown(keys: readonly string[], now: Date = new Date()): void {
  shown.push({ keys: [...keys], at: now.getTime() });
  if (shown.length > MAX) shown = shown.slice(-MAX);
}

export function recentShown(now: Date = new Date()): string[][] {
  return shown.filter((s) => now.getTime() - s.at <= TTL_MS).map((s) => [...s.keys]);
}

export function clearRecentShown(): void {
  shown = [];
}

/** Part C: every session logs its seed, so a bad order can be rebuilt exactly. */
export function logSessionOrder(kind: string, seed: string | undefined, size: number, deferred = 0): void {
  console.info(`[session] ${kind} seed=${seed ?? '(none)'} cards=${size} deferred=${deferred}`);
}
