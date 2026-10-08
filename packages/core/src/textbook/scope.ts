import type { Lexicon } from '../lexicon.js';
import type { Evidence, GrammarItem, ItemRef, Word } from '../types.js';
import {
  courseOrdinal,
  LAIXUE_COURSE,
  locateOrdinal,
  type Course,
} from './course.js';
import type { Lesson, MyClassSetting, Textbook } from './types.js';

export const TEXTBOOK_ID = 'laixue-1';

/** `textbook:laixue-1` */
export function textbookTag(textbookId: string = TEXTBOOK_ID): string {
  return `textbook:${textbookId}`;
}

/** `textbook:laixue-1:L03` */
export function lessonTag(n: number, textbookId: string = TEXTBOOK_ID): string {
  return `${textbookTag(textbookId)}:L${String(n).padStart(2, '0')}`;
}

const LESSON_TAG_RE = /^textbook:([^:]+):L(\d{1,2})$/;

/** Every lesson number a tag list places an item in (a word can recur). */
export function lessonsOfTags(tags: readonly string[], textbookId: string = TEXTBOOK_ID): number[] {
  const prefix = `${textbookTag(textbookId)}:`;
  const out: number[] = [];
  for (const t of tags) {
    if (!t.startsWith(prefix)) continue;
    const m = LESSON_TAG_RE.exec(t);
    if (m) out.push(Number(m[2]));
  }
  return out.sort((a, b) => a - b);
}

/** The lesson in which an item first appears, or undefined if not in the book. */
export function firstLessonOfTags(
  tags: readonly string[],
  textbookId: string = TEXTBOOK_ID,
): number | undefined {
  return lessonsOfTags(tags, textbookId)[0];
}

export function isTextbookTagged(
  tags: readonly string[],
  textbookId: string = TEXTBOOK_ID,
): boolean {
  return tags.includes(textbookTag(textbookId));
}

/** Where in the course an item first appears (its "home" lesson). */
export interface CourseLessonRef {
  bookId: string;
  /** Lesson number inside the book. */
  n: number;
  /** Global 1-based order in the course. */
  ordinal: number;
}

/**
 * The earliest lesson of the whole course a tag list places an item in. A word
 * taught in books 1 and 3 is ONE item carrying both tags; its home is book 1.
 */
export function homeLessonOfTags(
  tags: readonly string[],
  course: Course = LAIXUE_COURSE,
): CourseLessonRef | undefined {
  let best: CourseLessonRef | undefined;
  for (const t of tags) {
    const m = LESSON_TAG_RE.exec(t);
    if (!m) continue;
    const ordinal = courseOrdinal(course, m[1]!, Number(m[2]));
    if (ordinal === undefined) continue;
    if (!best || ordinal < best.ordinal) best = { bookId: m[1]!, n: Number(m[2]), ordinal };
  }
  return best;
}

/** Every course lesson a tag list places an item in, in course order. */
export function courseLessonsOfTags(
  tags: readonly string[],
  course: Course = LAIXUE_COURSE,
): CourseLessonRef[] {
  const out: CourseLessonRef[] = [];
  for (const t of tags) {
    const m = LESSON_TAG_RE.exec(t);
    if (!m) continue;
    const ordinal = courseOrdinal(course, m[1]!, Number(m[2]));
    if (ordinal !== undefined) out.push({ bookId: m[1]!, n: Number(m[2]), ordinal });
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * "My class" scope: which items are visible to chat targets and the known
 * sample. With the setting off everything is in scope (previous behaviour,
 * exactly). With it on, a textbook item whose first lesson in the COURSE is
 * more than `aheadLessons` past the class is out (the same "Lessons ahead of class"
 * setting the study focus uses). Items that aren't in the course at all are never affected.
 *
 * Phase 21 naming: `currentLesson` is always the lesson number inside its book;
 * a global course position is always called `courseOrdinal`.
 */
export interface ClassScope {
  enabled: boolean;
  /** Global order of the class's current lesson (for book 1 this equals the lesson number). */
  courseOrdinal: number;
  /** The book the class is in. */
  textbookId: string;
  /** Lesson number inside `textbookId`. */
  currentLesson: number;
  /** "Lessons ahead of class" (study settings `classAheadLessons`). */
  aheadLessons: number;
  course: Course;
}

/** Default preview window: the study order's default `classAheadLessons`. */
export const DEFAULT_CLASS_AHEAD_LESSONS = 1;

export function classScope(
  setting: MyClassSetting | undefined,
  opts: { course?: Course; aheadLessons?: number } = {},
): ClassScope {
  const course = opts.course ?? LAIXUE_COURSE;
  const textbookId = setting?.textbookId ?? TEXTBOOK_ID;
  const currentLesson = setting?.currentLesson ?? 1;
  return {
    enabled: !!setting?.enabled,
    courseOrdinal: courseOrdinal(course, textbookId, currentLesson) ?? currentLesson,
    textbookId,
    currentLesson,
    aheadLessons: opts.aheadLessons ?? DEFAULT_CLASS_AHEAD_LESSONS,
    course,
  };
}

/** Lessons up to and including the class + `aheadLessons` (course order) are in reach. */
export function maxVisibleLesson(scope: ClassScope): number {
  return scope.courseOrdinal + scope.aheadLessons;
}

export function tagsInScope(tags: readonly string[], scope: ClassScope): boolean {
  if (!scope.enabled) return true;
  const home = homeLessonOfTags(tags, scope.course);
  return home === undefined || home.ordinal <= maxVisibleLesson(scope);
}

export function wordInScope(w: Pick<Word, 'tags'>, scope: ClassScope): boolean {
  return tagsInScope(w.tags, scope);
}

/** Drop out-of-scope ids; unknown ids pass through. */
export function filterIdsInScope(
  ids: readonly string[],
  tagsById: (id: string) => readonly string[] | undefined,
  scope: ClassScope,
): string[] {
  if (!scope.enabled) return [...ids];
  return ids.filter((id) => {
    const tags = tagsById(id);
    return !tags || tagsInScope(tags, scope);
  });
}

/** The (book, lesson) a global order number points at. */
export function classPosition(scope: ClassScope): { bookId: string; n: number } {
  return locateOrdinal(scope.course, scope.courseOrdinal) ?? { bookId: scope.textbookId, n: scope.currentLesson };
}

/** Global order of one lesson of a book (its own number for an off-course book id). */
function ordinalOf(book: Pick<Textbook, 'id'>, n: number, course: Course): number {
  return courseOrdinal(course, book.id, n) ?? n;
}

/** Lessons whose content the class has covered (course order ≤ `through`). */
export function coveredLessons(
  books: Textbook | readonly Textbook[],
  through: number,
  course: Course = LAIXUE_COURSE,
): Lesson[] {
  const list = Array.isArray(books) ? (books as readonly Textbook[]) : [books as Textbook];
  return list
    .flatMap((b) => b.lessons.map((l) => ({ l, o: ordinalOf(b, l.n, course) })))
    .filter((x) => x.o <= through)
    .sort((a, b) => a.o - b.o)
    .map((x) => x.l);
}

/**
 * New evidence for "My class": every word and grammar item of lessons
 * ≤ current (in COURSE order, so all earlier books count) enters the learner
 * model as `introduced` (no FSRS review of its own, never "known"). Items
 * already carded are left alone by the handler.
 */
export function lessonCoveredEvidence(
  books: Textbook | readonly Textbook[],
  through: number,
  at: Date,
  opts: { includeSupplementary?: boolean; course?: Course } = {},
): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const push = (item: ItemRef, lessonId: string) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      item,
      skill: 'recognition',
      kind: 'textbook_lesson_covered',
      at,
      context: { source: 'textbook', refId: lessonId },
    });
  };
  for (const lesson of coveredLessons(books, through, opts.course)) {
    for (const id of lesson.vocab) push({ kind: 'word', id }, lesson.id);
    for (const id of lesson.grammarWords ?? []) push({ kind: 'word', id }, lesson.id);
    if (opts.includeSupplementary)
      for (const id of lesson.supplementary) push({ kind: 'word', id }, lesson.id);
    for (const id of lesson.grammar) push({ kind: 'grammar', id }, lesson.id);
  }
  return out;
}

export function isTextbookGrammar(g: GrammarItem, textbookId: string = TEXTBOOK_ID): boolean {
  return isTextbookTagged(g.tags ?? [], textbookId);
}

/**
 * Word ids a lesson-n scenario/sentence may use beyond what the learner
 * knows: every textbook word (core, supplementary, proper nouns) of lessons ≤ n.
 * With several books (`books` array + `bookId`) "≤" is in COURSE order, so a
 * book-2 lesson may use all of book 1 and the earlier lessons of book 2.
 */
export function lessonScopedWordIds(
  book: Textbook | readonly Textbook[],
  n: number,
  opts: { includeSupplementary?: boolean; bookId?: string; course?: Course } = {},
): Set<string> {
  const includeSupp = opts.includeSupplementary ?? true;
  const course = opts.course ?? LAIXUE_COURSE;
  const books = Array.isArray(book) ? (book as readonly Textbook[]) : [book as Textbook];
  const target = Array.isArray(book)
    ? (courseOrdinal(course, opts.bookId ?? books[0]!.id, n) ?? n)
    : ordinalOf(book as Textbook, n, course);
  const ids = new Set<string>();
  for (const b of books) {
    for (const l of b.lessons) {
      if (ordinalOf(b, l.n, course) > target) continue;
      for (const id of l.vocab) ids.add(id);
      for (const id of l.properNouns) ids.add(id);
      for (const id of l.grammarWords ?? []) ids.add(id);
      if (includeSupp) for (const id of l.supplementary) ids.add(id);
    }
  }
  return ids;
}

/**
 * Words the learner can read from parts they already have:
 *  - a lexicon word whose headword is a concatenation of headwords of
 *    `scopedIds` (沒有 = 沒 + 有, 一個 = 一 + 個), and
 *  - a single character that occurs inside a scoped multi-character word
 *    (唱 from 唱歌, 們 from 他們), which also makes 我們 = 我 + 們 readable.
 * Used so a textbook-scoped sentence isn't failed for an obvious part/compound.
 */
export function derivedCompoundIds(
  lexicon: Pick<Lexicon, 'allWords' | 'byId'>,
  scopedIds: ReadonlySet<string>,
): Set<string> {
  const pieces = new Set<string>();
  for (const id of scopedIds) {
    const w = lexicon.byId(id);
    if (!w) continue;
    for (const form of [w.headword, ...w.variants]) pieces.add(form);
  }
  const out = new Set<string>();
  const inner = new Set<string>();
  for (const p of pieces) if ([...p].length >= 2) for (const ch of p) inner.add(ch);
  for (const ch of inner) pieces.add(ch);
  for (const w of lexicon.allWords()) {
    if (!scopedIds.has(w.id) && [...w.headword].length === 1 && inner.has(w.headword)) {
      out.add(w.id);
    }
  }
  for (const w of lexicon.allWords()) {
    if (scopedIds.has(w.id) || out.has(w.id)) continue;
    const chars = [...w.headword];
    if (chars.length < 2 || chars.length > 4) continue;
    // dp[i]: chars[0..i) can be covered by pieces.
    const dp = new Array<boolean>(chars.length + 1).fill(false);
    dp[0] = true;
    for (let i = 1; i <= chars.length; i++) {
      for (let j = 0; j < i && !dp[i]; j++) {
        if (dp[j] && pieces.has(chars.slice(j, i).join(''))) dp[i] = true;
      }
    }
    if (dp[chars.length]) out.add(w.id);
  }
  return out;
}
