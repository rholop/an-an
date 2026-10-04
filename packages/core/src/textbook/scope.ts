import type { Lexicon } from '../lexicon.js';
import type { Evidence, GrammarItem, ItemRef, Word } from '../types.js';
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

/** Badge text, e.g. "來學華語 L3". */
export function lessonBadge(n: number): string {
  return `來學華語 L${n}`;
}

const LESSON_TAG_RE = /^textbook:[^:]+:L(\d{1,2})$/;

/** Every lesson number a tag list places an item in (a word can recur). */
export function lessonsOfTags(tags: readonly string[], textbookId: string = TEXTBOOK_ID): number[] {
  const prefix = `${textbookTag(textbookId)}:`;
  const out: number[] = [];
  for (const t of tags) {
    if (!t.startsWith(prefix)) continue;
    const m = LESSON_TAG_RE.exec(t);
    if (m) out.push(Number(m[1]));
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

/**
 * "My class" scope: which items are visible to chat targets and the known
 * sample. With the setting off everything is in scope (previous behaviour,
 * exactly). With it on, a textbook item from a lesson beyond current+1 is out.
 * Items that aren't in the book at all are never affected.
 */
export interface ClassScope {
  enabled: boolean;
  currentLesson: number;
  textbookId: string;
}

export function classScope(setting: MyClassSetting | undefined): ClassScope {
  return {
    enabled: !!setting?.enabled,
    currentLesson: setting?.currentLesson ?? 1,
    textbookId: setting?.textbookId ?? TEXTBOOK_ID,
  };
}

/** Lessons up to and including `current + 1` are in reach (i+1 trickle). */
export function maxVisibleLesson(scope: ClassScope): number {
  return scope.currentLesson + 1;
}

export function tagsInScope(tags: readonly string[], scope: ClassScope): boolean {
  if (!scope.enabled) return true;
  const first = firstLessonOfTags(tags, scope.textbookId);
  return first === undefined || first <= maxVisibleLesson(scope);
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

/** Lessons whose content the class has covered (n ≤ current). */
export function coveredLessons(book: Textbook, currentLesson: number): Lesson[] {
  return book.lessons.filter((l) => l.n <= currentLesson);
}

/**
 * New evidence for "My class": every word and grammar item of lessons
 * ≤ current enters the learner model as `introduced` (no FSRS review of its
 * own, never "known"). Items already carded are left alone by the handler.
 */
export function lessonCoveredEvidence(
  book: Textbook,
  currentLesson: number,
  at: Date,
  opts: { includeSupplementary?: boolean } = {},
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
  for (const lesson of coveredLessons(book, currentLesson)) {
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
 */
export function lessonScopedWordIds(
  book: Textbook,
  n: number,
  opts: { includeSupplementary?: boolean } = {},
): Set<string> {
  const includeSupp = opts.includeSupplementary ?? true;
  const ids = new Set<string>();
  for (const l of book.lessons) {
    if (l.n > n) continue;
    for (const id of l.vocab) ids.add(id);
    for (const id of l.properNouns) ids.add(id);
    for (const id of l.grammarWords ?? []) ids.add(id);
    if (includeSupp) for (const id of l.supplementary) ids.add(id);
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
