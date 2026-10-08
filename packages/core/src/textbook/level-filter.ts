// Phase 13 §5: how the header level picker filters textbook content (scenarios,
// sentences, journal prompts). The chosen level's items come first, easier ones
// stay available below, harder ones are hidden. Due reviews never go through here.
import { levelIndex, levelLabel, type Level } from '../levels.config.js';
import { bookTitle, courseBook, courseLessonLevel, LAIXUE_COURSE, type Course } from './course.js';

export type LevelFit = 'match' | 'easier' | 'harder';

export function levelFit(itemLevel: Level, chosen: Level): LevelFit {
  const d = levelIndex(itemLevel) - levelIndex(chosen);
  return d === 0 ? 'match' : d < 0 ? 'easier' : 'harder';
}

/**
 * Hides items harder than `chosen`; the rest are ordered "your level first, then
 * easier ones (closest first)". The sort is stable, so course order is kept inside a group.
 */
export function filterByLevel<T>(items: readonly T[], levelOf: (t: T) => Level, chosen: Level): T[] {
  const rank = (t: T) => levelIndex(chosen) - levelIndex(levelOf(t)); // 0 = match, 1.. = easier
  return items
    .map((t, i) => ({ t, i, r: rank(t) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
}

/** "來學華語 2 · A1 — about L1 入門級 · A1": the hint next to the picker while My class is on. */
export function classLevelHint(
  bookId: string,
  lesson: number,
  course: Course = LAIXUE_COURSE,
): string | undefined {
  const book = courseBook(course, bookId);
  if (!book) return undefined;
  const level = courseLessonLevel(course, bookId, lesson);
  return `${bookTitle(bookId, course)} (${book.levelLabel}) ≈ ${levelLabel(level)}`;
}
