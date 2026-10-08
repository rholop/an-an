/**
 * Phase 21 Part H: the ONE vocabulary of the interface. Every lesson, book and level label and
 * every progress term, feedback line and button that more than one screen shows comes from here,
 * so two tabs can never word the same thing differently. (The formats themselves are built by
 * core's `bookTitle` / `lessonBadge` / `levelLabel` / `tocflLabel`, which core needs too.)
 *
 * Rules: "L" only ever means a TOCFL level; a lesson is always "Lesson N". Progress terms are only
 * New, Due, Learned, Mastered (and Imported for Anki / placement seeds), as defined in
 * packages/core/src/progress.
 */
import {
  bookTitle,
  courseBook,
  LAIXUE_COURSE,
  lessonBadge,
  lessonShort,
  levelLabel,
  levelShort,
  stepName,
  tocflLabel,
  type Level,
} from '@anan/core';

export { bookTitle, levelLabel, levelShort, stepName, tocflLabel };

/** "來學華語 1 · Lesson 3" */
export const lessonLabel = (n: number, bookId?: string): string => lessonBadge(n, bookId);
/** "Lesson 3" (only where the book is already on screen). */
export const lessonOnly = (n: number): string => lessonShort(n);
/** "Let's Learn Mandarin 1": the subtitle on the Textbook page only. */
export function bookSubtitle(bookId: string): string {
  const b = courseBook(LAIXUE_COURSE, bookId);
  const no = /(\d+)$/.exec(bookId)?.[1] ?? '';
  return b ? `Let's Learn Mandarin ${no}`.trim() : '';
}
/** Nav entry while My class is on: "Textbook · Lesson 3". */
export const navTextbookLabel = (n: number): string => `Textbook · ${lessonShort(n)}`;
/** The class setting (never called "current lesson"): "Your class: Lesson 3". */
export const yourClassLabel = (n: number, bookId?: string): string =>
  `Your class: ${bookId ? lessonBadge(n, bookId) : lessonShort(n)}`;
/** "Current lesson" only ever means the active study lesson. */
export const CURRENT_LESSON = 'Current lesson';
/** Word popover source line: "TOCFL L1 · 來學華語 2 · Lesson 3". */
export function wordSourceLabel(level: Level | null | undefined, home?: { n: number; bookId: string }): string {
  return [level ? tocflLabel(level) : undefined, home ? lessonBadge(home.n, home.bookId) : undefined]
    .filter(Boolean)
    .join(' · ');
}
/** Header picker: "Your level". */
export const YOUR_LEVEL = 'Your level';
/** Phase 22: the header picker's one label. */
export const LEVEL = 'Level';

// --- progress terms -------------------------------------------------------------------------
export const TERM = {
  new: 'New',
  due: 'Due',
  learned: 'Learned',
  mastered: 'Mastered',
  imported: 'Imported',
  leech: 'Tricky word',
} as const;
export const PROGRESS_INFO =
  "Learned: you've got it right in review. Mastered: you'd still remember it in about 3 weeks and can produce it from English.";
export const pct = (share: number): string => `${Math.round(share * 100)}%`;
/** "Learned 40% · Mastered 12%" */
export const learnedMasteredLine = (p: { learnedShare: number; masteredShare: number }): string =>
  `${TERM.learned} ${pct(p.learnedShare)} · ${TERM.mastered} ${pct(p.masteredShare)}`;
/** "3 of 12 lessons mastered" */
export const lessonsMasteredLine = (done: number, total: number): string =>
  `${done} of ${total} lesson${total === 1 ? '' : 's'} mastered`;
/** One coverage label (Chat, Progress, Reader). */
export const coverageLine = (share: number): string => `You know about ${pct(share)} of the words here`;
/** Review header: "12 due · 3 new". */
export const dueNewLine = (due: number, fresh: number): string => `${due} ${TERM.due.toLowerCase()} · ${fresh} ${TERM.new.toLowerCase()}`;
/** Phase 22: a clock time for "next at …" ("3:40 pm"). */
export const timeOfDay = (d: Date): string =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(/\s+/g, ' ');
/** Phase 22: "3 more later today (next at 3:40 pm)". */
export const laterTodayLine = (n: number, next?: Date): string =>
  `${n} more later today${next ? ` (next at ${timeOfDay(next)})` : ''}`;
/** Phase 22: the one review status line: "3 due now", plus later today when there are any. */
export const dueNowLine = (s: { dueNow: number; laterToday: number; nextDueAt?: Date }): string =>
  `${s.dueNow} ${TERM.due.toLowerCase()} now${s.laterToday > 0 ? ` · ${laterTodayLine(s.laterToday, s.nextDueAt)}` : ''}`;
export const waterAllLabel = (n: number): string => `💧 Water all (${n})`;
export const reviewAllLabel = (n: number): string => `Review all (${n})`;
export const REVIEW_EARLY = 'Review early';
export const ALL_WATERED = 'All watered 🌱';
export const COME_BACK_TOMORROW = 'All watered 🌱 Come back tomorrow.';
export const FORECAST_REST_OF_TODAY = 'Rest of today';
/** Phase 22: Water all's end-of-session line. */
export const wateredSummary = (words: number, perked: number): string =>
  `Watered ${words} word${words === 1 ? '' : 's'} 🌱${perked > 0 ? ` ${perked} perked up to ${TERM.learned}` : ''}`;
/** Listening progress (Part C): practised = answered at least once; strong = listening stability
 * ≥ PROGRESS_CONFIG.listeningStrongDays. Listening never counts toward Mastered, so it keeps its own word. */
export const listeningLine = (practised: number, strong: number): string =>
  `Listening: ${practised} practised, ${strong} strong`;
export const placedAtLine = (level: Level): string => `Placed at ${levelShort(level)}`;

// --- actions --------------------------------------------------------------------------------
export const STUDY_THIS_LESSON = 'Study this lesson';
export const REPORT_LABEL = "⚑ Something's wrong";
export const REPORT_THANKS = "Thanks, we'll look at it.";
export const UNDO = 'Undo';
export const NEXT = 'Next';
export const MINE_IS_RIGHT = 'I think mine is right too';
export const HOME = 'Home';

// --- answer feedback ------------------------------------------------------------------------
export const FEEDBACK_CORRECT = '✓ Correct';
export const FEEDBACK_WRONG_TONE = 'Right word, wrong tone';
export const feedbackWrong = (answer: string, reading?: string): string =>
  `✗ Not quite — it's ${answer}${reading ? ` (${reading})` : ''}`;

// --- empty states ---------------------------------------------------------------------------
export const NOTHING_DUE = 'Nothing due right now. Nice work.';
export const nothingHere = (what: string): string => `No ${what} right now.`;
export const waitingSiblings = (n: number): string =>
  `${n} card${n === 1 ? ' is' : 's are'} waiting a few minutes so ${n === 1 ? "it isn't" : "they aren't"} next to ${n === 1 ? 'its partner' : 'their partners'}.`;

// --- chats (scenario and open chat use the same words) ---------------------------------------
export const END_CHAT = 'End chat';
export const CHAT_FINISHED = 'Chat finished';
export const NEW_WORDS_MET = 'New words you met';
export const BACK_TO_CHATS = '← Chats';
export const messagesFromYou = (n: number): string => `${n} message${n === 1 ? '' : 's'} from you`;
export const UNRELIABLE_REPLY = "Couldn't get a reliable reply, try again";
