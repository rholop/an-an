// Phase 24 Part A: the vocabulary ladder. ONE ranking of every word for anything the app writes
// for the learner (graded stories, Phase 18 open chat): what they know first, then this lesson,
// the next lesson, the one after, the picked TOCFL level, and anything else last. Pure.

import type { Lexicon } from '../lexicon.js';
import { levelIndex, type Level } from '../levels.config.js';
import { courseOrdinal, LAIXUE_COURSE } from '../textbook/course.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { StudyFocus } from '../study/study-focus.js';

/** 1 learned / due / learning / catch-up · 2 this lesson · 3 next lesson · 4 the lesson after ·
 * 5 the picked TOCFL level (and the ones below it) · 6 anything else. */
export type VocabRung = 1 | 2 | 3 | 4 | 5 | 6;

export interface LadderLesson {
  lessonId: string;
  bookId: string;
  n: number;
  topic: string;
  titleEn: string;
}

/** Where "this lesson" and the next ones come from (Phase 18's `UpcomingSource`). */
export type LadderSource = 'study-order' | 'level-step' | 'none';

export interface VocabLadderInput {
  lexicon: Pick<Lexicon, 'allWords'>;
  /** The picked TOCFL level (header). */
  level: Level;
  /** Learned words (Phase 21 "Learned", "I already know this" included). */
  knownIds: ReadonlySet<string>;
  /** Due now. */
  dueIds: ReadonlySet<string>;
  /** Learning / introduced. */
  learningIds: ReadonlySet<string>;
  /** Imported textbooks, in course order. */
  books: readonly Textbook[];
  /** Phase 14/21: the study focus (it follows My class and applies the TOCFL gate). */
  studyFocus?: StudyFocus;
}

export interface VocabLadderOptions {
  /** Rung 5 also covers the levels below the picked one (an unseen N1 word is not "advanced"). */
  rung5IncludesLowerLevels: boolean;
  /** A "rest of the level" step: at most this many of its words are rung 2. */
  levelStepWordCap: number;
}

export const VOCAB_LADDER_DEFAULTS: VocabLadderOptions = { rung5IncludesLowerLevels: true, levelStepWordCap: 40 };

export interface VocabLadder {
  /** The rung of a word id (6 when it is in none of the lists). */
  rung(id: string): VocabRung;
  /** Word ids per rung 1–5, each word on its lowest rung only. */
  ids: Readonly<Record<1 | 2 | 3 | 4 | 5, ReadonlySet<string>>>;
  source: LadderSource;
  /** The active lesson (rung 2), the next one (rung 3) and the one after (rung 4). */
  lessons: { active?: LadderLesson; next?: LadderLesson; after?: LadderLesson };
  /** Core words of the active lesson and the two after it, in that order (Phase 18 "upcoming"). */
  upcomingWordIds: string[];
  /** Grammar item ids: learned and active lessons (allowed), and the next lesson's (once at most). */
  grammar: { allowed: string[]; next: string[]; upcoming: string[] };
  /** Proper nouns of the lessons up to the active one (names the learner has met). */
  properNounIds: string[];
}

const describe = (l: Lesson, bookId: string): LadderLesson => ({ lessonId: l.id, bookId, n: l.n, topic: l.topic, titleEn: l.titleEn });

/** A lesson's core words (vocab + grammar words), names left out. */
function lessonCore(l: Lesson): string[] {
  const proper = new Set(l.properNouns);
  return [...new Set([...l.vocab, ...(l.grammarWords ?? [])])].filter((id) => !proper.has(id));
}

/** Every lesson of the imported books, in course order. */
export function lessonsInCourseOrder(books: readonly Textbook[]): Array<{ lesson: Lesson; bookId: string; ordinal: number }> {
  const out: Array<{ lesson: Lesson; bookId: string; ordinal: number }> = [];
  for (const b of books)
    for (const l of b.lessons) {
      const ordinal = courseOrdinal(LAIXUE_COURSE, b.id, l.n);
      if (ordinal !== undefined) out.push({ lesson: l, bookId: b.id, ordinal });
    }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Builds the ladder. The active lesson is the study focus's (Phase 21: it follows My class); the
 * next lessons skip lessons already mastered and lessons held back by the TOCFL gate (a gated
 * lesson is never "next"). With study order off or no textbook, rungs 2–4 are empty.
 */
export function vocabLadder(input: VocabLadderInput, options: Partial<VocabLadderOptions> = {}): VocabLadder {
  const opts = { ...VOCAB_LADDER_DEFAULTS, ...options };
  const focus = input.studyFocus?.enabled ? input.studyFocus : undefined;

  // rung 1: learned, due, learning and the catch-up lessons' words
  const r1 = new Set<string>([...input.knownIds, ...input.dueIds, ...input.learningIds]);
  for (const i of focus?.reviewItems ?? []) if (i.kind === 'word') r1.add(i.id);

  let source: LadderSource = 'none';
  const lessons: VocabLadder['lessons'] = {};
  const window: Array<{ lesson: Lesson; bookId: string; ordinal: number }> = [];
  let levelWords: string[] = [];
  const grammarAllowed: string[] = [];
  const properNounIds: string[] = [];
  const step = focus?.activeStep;
  if (input.books.length > 0 && step) {
    const ordered = lessonsInCourseOrder(input.books);
    if (step.kind === 'level') {
      source = 'level-step';
      levelWords = (focus?.focusItems ?? []).filter((i) => i.kind === 'word').map((i) => i.id).slice(0, opts.levelStepWordCap);
      for (const o of ordered) {
        grammarAllowed.push(...o.lesson.grammar);
        properNounIds.push(...o.lesson.properNouns);
      }
    } else {
      const at = ordered.findIndex((o) => o.lesson.id === step.lessonId);
      if (at >= 0) {
        source = 'study-order';
        const skip = new Set([...(focus?.gatedLessonIds ?? []), ...(focus?.masteredLessonIds ?? [])]);
        window.push(ordered[at]!, ...ordered.slice(at + 1).filter((o) => !skip.has(o.lesson.id)).slice(0, 2));
        for (const o of ordered.slice(0, at + 1)) {
          grammarAllowed.push(...o.lesson.grammar);
          properNounIds.push(...o.lesson.properNouns);
        }
      }
    }
  }
  [lessons.active, lessons.next, lessons.after] = window.map((w) => describe(w.lesson, w.bookId));

  const sets: [Set<string>, Set<string>, Set<string>, Set<string>, Set<string>] = [r1, new Set(), new Set(), new Set(), new Set()];
  const place = (ids: Iterable<string>, rungIdx: 1 | 2 | 3) => {
    for (const id of ids) if (!sets.slice(0, rungIdx).some((s) => s.has(id))) sets[rungIdx].add(id);
  };
  if (source === 'level-step') place(levelWords, 1);
  window.forEach((w, i) => place(lessonCore(w.lesson), (i + 1) as 1 | 2 | 3));

  const picked = levelIndex(input.level);
  for (const w of input.lexicon.allWords()) {
    if (w.source !== 'tocfl' || w.level === null) continue;
    const li = levelIndex(w.level);
    if (!(opts.rung5IncludesLowerLevels ? li <= picked : li === picked)) continue;
    if (sets.slice(0, 4).some((s) => s.has(w.id))) continue;
    sets[4].add(w.id);
  }

  const rung = (id: string): VocabRung => {
    for (let i = 0; i < 5; i++) if (sets[i]!.has(id)) return (i + 1) as VocabRung;
    return 6;
  };
  const upcomingWordIds = source === 'level-step' ? levelWords : [...new Set(window.flatMap((w) => lessonCore(w.lesson)))];
  return {
    rung,
    ids: { 1: sets[0], 2: sets[1], 3: sets[2], 4: sets[3], 5: sets[4] },
    source,
    lessons,
    upcomingWordIds,
    grammar: {
      allowed: [...new Set(grammarAllowed)],
      next: window[1]?.lesson.grammar ?? [],
      upcoming: [...new Set(window.flatMap((w) => w.lesson.grammar))],
    },
    properNounIds: [...new Set(properNounIds)],
  };
}

/** The best (lowest) rung among a token's lexicon candidates. */
export function bestRung(ladder: Pick<VocabLadder, 'rung'>, candidateIds: readonly string[]): { rung: VocabRung; id?: string } {
  let best: { rung: VocabRung; id?: string } = { rung: 6 };
  for (const id of candidateIds) {
    const r = ladder.rung(id);
    if (r < best.rung) best = { rung: r, id };
  }
  if (best.id === undefined && candidateIds[0]) best = { rung: 6, id: candidateIds[0] };
  return best;
}
