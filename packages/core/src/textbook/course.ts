// Phase 13: a textbook *series* is one continuous course. Books are sections of
// one path; every lesson has a global order (book 1 L1 … last lesson of book 4).
// The structure lives here (like levels.config.ts) so scope checks work from
// tags alone, without loading any book.

import type { Level } from '../levels.config.js';

export interface CourseBook {
  /** 'laixue-2' */
  id: string;
  titleZh: string;
  titleEn: string;
  /** Number of lessons (the book's own count). */
  lessons: number;
  /** The owner's label for the book ("pre-A1", "A2–B1"). */
  levelLabel: string;
  /** App level of the book's content when a word has no TOCFL level. */
  level: Level;
  /** Book 4 style split: lessons after `splitAfter` use `laterLevel`. */
  laterLevel?: { splitAfter: number; level: Level };
}

export interface Course {
  id: string;
  titleZh: string;
  titleEn: string;
  books: readonly CourseBook[];
}

export const LAIXUE_COURSE: Course = {
  id: 'laixue',
  titleZh: '來學華語',
  titleEn: "Let's Learn Mandarin",
  books: [
    {
      id: 'laixue-1',
      titleZh: '來學華語 第一冊',
      titleEn: "Let's Learn Mandarin 1",
      lessons: 10,
      levelLabel: 'pre-A1',
      level: 'N1',
    },
    {
      id: 'laixue-2',
      titleZh: '來學華語 第二冊',
      titleEn: "Let's Learn Mandarin 2",
      lessons: 10,
      levelLabel: 'A1',
      level: 'L1',
    },
    {
      id: 'laixue-3',
      titleZh: '來學華語 第三冊',
      titleEn: "Let's Learn Mandarin 3",
      lessons: 10,
      levelLabel: 'A2',
      level: 'L2',
    },
    {
      id: 'laixue-4',
      titleZh: '來學華語 第四冊',
      titleEn: "Let's Learn Mandarin 4",
      lessons: 10,
      levelLabel: 'A2–B1',
      level: 'L2',
      laterLevel: { splitAfter: 5, level: 'L3' },
    },
  ],
};

export const COURSE_BOOK_IDS: readonly string[] = LAIXUE_COURSE.books.map((b) => b.id);

export function courseBook(course: Course, bookId: string): CourseBook | undefined {
  return course.books.find((b) => b.id === bookId);
}

/** Book number from its id: 'laixue-3' → 3 (position in the course when the id has no digit). */
export function bookNumber(course: Course, bookId: string): number {
  const m = /(\d+)$/.exec(bookId);
  if (m) return Number(m[1]);
  return course.books.findIndex((b) => b.id === bookId) + 1;
}

/** Global 1-based order of a lesson in the course, or undefined for an unknown book / lesson. */
export function courseOrdinal(
  course: Course,
  bookId: string,
  n: number,
): number | undefined {
  let before = 0;
  for (const b of course.books) {
    if (b.id === bookId) return Number.isInteger(n) && n >= 1 && n <= b.lessons ? before + n : undefined;
    before += b.lessons;
  }
  return undefined;
}

export function courseLessonCount(course: Course): number {
  return course.books.reduce((s, b) => s + b.lessons, 0);
}

/** Inverse of `courseOrdinal`. */
export function locateOrdinal(
  course: Course,
  ordinal: number,
): { bookId: string; n: number } | undefined {
  let left = ordinal;
  if (!Number.isInteger(left) || left < 1) return undefined;
  for (const b of course.books) {
    if (left <= b.lessons) return { bookId: b.id, n: left };
    left -= b.lessons;
  }
  return undefined;
}

/** App level of one lesson (book default; book 4 second half is one level up). */
export function courseLessonLevel(course: Course, bookId: string, n: number): Level {
  const b = courseBook(course, bookId);
  if (!b) return 'N1';
  return b.laterLevel && n > b.laterLevel.splitAfter ? b.laterLevel.level : b.level;
}

/* Phase 21 Part H: the ONE place lesson and book labels are built. "L" only ever means a TOCFL
 * level, so a lesson is always "Lesson N". UI code uses these through apps/web/src/lib/labels.ts. */

/** "來學華語 2" */
export function bookTitle(bookId: string = 'laixue-1', course: Course = LAIXUE_COURSE): string {
  return `${course.titleZh} ${bookNumber(course, bookId)}`;
}

/** "Lesson 5" (inside a screen that already names the book). */
export function lessonShort(n: number): string {
  return `Lesson ${n}`;
}

/** "來學華語 2 · Lesson 5" */
export function lessonBadge(n: number, bookId: string = 'laixue-1', course: Course = LAIXUE_COURSE): string {
  return `${bookTitle(bookId, course)} · ${lessonShort(n)}`;
}
