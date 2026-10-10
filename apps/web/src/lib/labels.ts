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
/** Phase 29 Part B.2: the Listen tab's own count (listening is never part of watering or Review). */
export const listenLine = (n: number): string => `${n} to listen to this session`;
/** Phase 29 Part B.5: Again repeats in this sitting are shown apart ("12 due · 3 new · +2 again"). */
export const dueNewLine = (due: number, fresh: number, again = 0): string =>
  `${due} ${TERM.due.toLowerCase()} · ${fresh} ${TERM.new.toLowerCase()}${again > 0 ? ` · +${again} again` : ''}`;
/** Phase 23: a clock time in the profile's time zone ("4 pm", "3:40 pm"), right on any device. */
export const timeOfDay = (d: Date, timeZone?: string): string => {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) };
  return d.toLocaleTimeString('en-US', opts).toLowerCase().replace(/\s+/g, ' ').replace(':00 ', ' ');
};
/** Phase 23: the two review sessions. */
export const SESSION_NAME = { morning: 'Morning review', evening: 'Evening review' } as const;
const cardCount = (n: number) => `${n} card${n === 1 ? '' : 's'}`;
/** "Evening review opens at 4 pm (31 cards)" ("… tomorrow" when it opens on another local day). */
export const nextSessionLine = (
  next: { name: 'morning' | 'evening'; opensAt: Date; count: number },
  timeZone: string,
  now: Date = new Date(),
): string => {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const tomorrow = day(next.opensAt) !== day(now) ? ' tomorrow' : '';
  return `${SESSION_NAME[next.name]} opens at ${timeOfDay(next.opensAt, timeZone)}${tomorrow} (${cardCount(next.count)})`;
};
/** Phase 23: the one review status line. In a session: "Morning review · 23 cards". Between
 * sessions: "Morning review done · Evening review opens at 4 pm (31 cards)". */
export const sessionLine = (
  s: {
    session: 'morning' | 'evening' | 'between';
    sessionCards: number;
    previousSession: { name: 'morning' | 'evening'; left: number };
    nextSession: { name: 'morning' | 'evening'; opensAt: Date; count: number };
    timeZone: string;
  },
  now: Date = new Date(),
): string => {
  if (s.session !== 'between') return `${SESSION_NAME[s.session]} · ${cardCount(s.sessionCards)}`;
  const prev = s.previousSession;
  const done =
    prev.left > 0
      ? `${cardCount(prev.left)} left from the ${prev.name} review`
      : `${SESSION_NAME[prev.name]} done`;
  return `${done} · ${nextSessionLine(s.nextSession, s.timeZone, now)}`;
};
/** Forecast column: "Today", then weekday names, in the profile's zone. */
export const forecastDayLabel = (day: string, today: string): string =>
  day === today ? 'Today' : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
export const waterAllLabel = (n: number): string => `💧 Water all (${n})`;
export const reviewAllLabel = (n: number): string => `Review all (${n})`;
export const REVIEW_EARLY = 'Review early';
export const ALL_WATERED = 'All watered 🌱';
/** Phase 27: the garden between sessions (or once this session is watered):
 * "All watered 🌱 · 10 words in the evening session (opens 4 pm)". */
export const allWateredLine = (
  next: { name: 'morning' | 'evening'; opensAt: Date },
  words: number,
  timeZone: string,
  now: Date = new Date(),
): string => {
  if (words === 0) return ALL_WATERED;
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const tomorrow = day(next.opensAt) !== day(now) ? ' tomorrow' : '';
  return `${ALL_WATERED} · ${words} word${words === 1 ? '' : 's'} in the ${next.name} session (opens ${timeOfDay(next.opensAt, timeZone)}${tomorrow})`;
};
/** Phase 27: the faint droplet's tooltip ("Evening session"). */
export const nextSessionTip = (name: 'morning' | 'evening'): string => `${name === 'morning' ? 'Morning' : 'Evening'} session`;
/** Phase 27: the lesson page between sessions (the same cards as the garden plot). */
export const lessonNothingThisSession = (next: { name: 'morning' | 'evening' }, count: number): string =>
  `Nothing from this lesson to review in this session.${count > 0 ? ` ${count} word${count === 1 ? '' : 's'} from it in the ${next.name} session.` : ''}`;
/** Phase 27: the lesson study end screen: words that left their short learning step. */
export const learnedTodayLine = (n: number): string => `${TERM.learned} today: ${n} word${n === 1 ? '' : 's'}`;
export const NOTHING_NEXT_SESSION = 'All watered 🌱 Nothing waiting for the next session yet.';
/** Phase 22: Water all's end-of-session line. */
export const wateredSummary = (words: number, perked: number): string =>
  `Watered ${words} word${words === 1 ? '' : 's'} 🌱${perked > 0 ? ` ${perked} perked up to ${TERM.learned}` : ''}`;
/** Listening progress (Part C): practised = answered at least once; strong = listening stability
 * ≥ PROGRESS_CONFIG.listeningStrongDays. Listening never counts toward Mastered, so it keeps its own word. */
export const listeningLine = (practised: number, strong: number): string =>
  `Listening: ${practised} practised, ${strong} strong`;
// --- Phase 23: Review faces and pinyin practice -----------------------------------------------
export const FACE_LABEL = {
  meaning: 'Meaning',
  pick: 'Pick the Mandarin',
  recall: 'Recall the Mandarin',
  say: 'Say it',
  grammar: 'Grammar',
} as const;
export const PINYIN_TAB = 'Pinyin & tones';
/** "Pinyin 80%": share of Learned words whose reading card is Learned too. */
export const pinyinShareLine = (share: number): string => `Pinyin ${pct(share)}`;
const toneName = (t: number) => (t === 5 ? 'neutral' : ['1st', '2nd', '3rd', '4th'][t - 1] ?? `${t}`);
/** "You mix up 2nd and 3rd tone most (14 times this week)". */
export const toneConfusionLine = (a: number, b: number, count: number): string =>
  `You mix up ${toneName(a)} and ${toneName(b)} tone most (${count} time${count === 1 ? '' : 's'} this week)`;
export const toneLabel = toneName;

export const placedAtLine = (level: Level): string => `Placed at ${levelShort(level)}`;

// --- actions --------------------------------------------------------------------------------
export const STUDY_THIS_LESSON = 'Study this lesson';
export const REPORT_LABEL = "⚑ Something's wrong";
export const REPORT_THANKS = "Thanks, we'll look at it.";
export const UNDO = 'Undo';
export const NEXT = 'Next';
export const MINE_IS_RIGHT = 'I think mine is right too';
export const HOME = 'Home';
/** Phase 31 Part G: Settings → Your progress → Saved versions. */
export const SAVED_VERSIONS_KEPT = 'The server keeps your last 10 saved versions.';

// --- journal corrections (Phase 31) ----------------------------------------------------------
export const ISSUE_TYPE_LABEL = {
  error: 'Error',
  unnatural: 'Unnatural',
  mainland_style: 'Mainland wording',
} as const;
/** The legend explains itself: one line per label. */
export const ISSUE_TYPE_MEANING = {
  error: 'error = a mistake: grammar, the wrong word or the wrong order.',
  unnatural: 'unnatural = understandable, but not how people say it in Taiwan.',
  mainland_style: 'mainland wording = a word or phrasing from mainland China; Taiwan says it differently.',
} as const;
export const WHY = 'Why?';
export const ASK_ABOUT_THIS = 'Ask about this';
export const WHAT_DID_YOU_MEAN = 'What did you mean?';
export const MINE_IS_RIGHT_JOURNAL = 'I think mine is right';
export const ADD_TO_REVIEW = 'Add to review';
export const ADDED_TO_REVIEW = '✓ Added to review';
export const NOT_SURE_EXPLANATION = "We're not sure about this one, so it won't be added to your practice.";
export const CHECKING_EXPLANATION = 'Checking this explanation…';
export const YOU_ARE_RIGHT_REMOVED = "You're right; removed.";
export const stillAMistake = (problem?: string): string =>
  `Still a mistake${problem ? `: ${problem}` : '.'}`;
export const readAsLine = (en: string): string => `Read as: ${en}`;
export const sameMistakeLine = (n: number): string => `You've made this mistake ${n} times`;
export const UNDERSTANDABLE_NOTE = 'Your version is understandable; this is how people usually say it.';

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

// --- Phase 24: graded stories ---------------------------------------------------------------
export const STORIES = 'Stories';
export const NEXT_STORY = 'Next story';
/** Phase 25: the only thing a failed story write ever shows (never a raw error), with RETRY. */
export const STORY_UNAVAILABLE = "Couldn't write a story right now. Try again.";
export const RETRY = 'Retry';
/** Phase 25: when the free Gemini quota is used up. */
export const AI_QUOTA_USED = 'The free AI quota is used up for now. Try again in a few minutes.';
export const STORY_WRITING = 'Writing a story…';
/** Phase 26 Part F: what the button says while a story is written, checked and repaired. */
export const STORY_STAGE = {
  writing: 'Writing a story… (checking the words)',
  repairing: 'Fixing a few words…',
  checking: 'Reading it through…',
} as const;
export const TRY_ANOTHER_TOPIC = 'Try another topic';
export const READ_LESSON_STORY = 'Read a lesson story';
export const NO_LESSON_STORY = 'No lesson stories are ready for this lesson yet.';
/** Phase 26 Part C: the mini lesson before a story. */
export const WORDS_IN_STORY = 'Words in this story';
export const START_READING = 'Start reading';
export const NO_QUESTIONS = 'No questions for this one.';
export const storyRungLabel = (rung: number): string =>
  rung === 2 ? 'This lesson' : rung === 3 ? 'Next lesson' : rung === 4 ? 'Coming lesson' : 'New word';
export const READ_AGAIN = 'Read again';
export const EASIER_NOW = "You'll find this one easier now";
export const STORY_DIFFICULTY = { easier: 'Easier', middle: 'Just right', harder: 'Harder' } as const;
/** "A 2-minute story using Lesson 3 words" (Home and the Stories section). */
/** Phase 30: a story's lesson badge, "來學華語 1 · Lesson 2 · catch-up" for an earlier lesson not yet Mastered. */
export const storyLessonBadge = (n: number, bookId: string, catchUp = false): string => `${lessonLabel(n, bookId)}${catchUp ? ' · catch-up' : ''}`;
export const storyPitch = (minutes: number, lesson?: { n: number; bookId: string }): string =>
  `A ${minutes}-minute story${lesson ? ` using ${lessonShort(lesson.n)} words` : ''}`;
/** After reading: "You read 214 characters · 96% words you know". */
export const storyReadLine = (chars: number, knownShare: number): string =>
  `You read ${chars} characters · ${pct(knownShare)} words you know`;
/** Progress: "Characters read this week: 214 · 2 stories finished". */
export const storyWeekLine = (chars: number, finished: number): string =>
  `Characters read this week: ${chars} · ${finished} ${finished === 1 ? 'story' : 'stories'} finished`;
export const storyScoreLine = (right: number, of: number): string => `${right} of ${of} right`;

// Phase 25: the lesson grammar step and grammar progress dots.
/** ●●○ = 2 of 3 correct uses. */
export const grammarDotsText = (dots: number, need: number): string =>
  '●'.repeat(Math.min(dots, need)) + '○'.repeat(Math.max(0, need - dots));
export const grammarDotsLabel = (dots: number, need: number): string => `${Math.min(dots, need)} of ${need} correct uses`;
/** "7 of 9 · +1 extra" */
export const grammarStepPosition = (i: number, base: number, extras: number): string =>
  `${Math.min(i, base)} of ${base}${extras > 0 ? ` · +${extras} extra` : ''}`;
/** After the step: "了 (new situation): 2 of 3. Come back tomorrow to master it." */
export const grammarPointOutcome = (
  name: string,
  dots: number,
  need: number,
  state: 'mastered' | 'tomorrow' | 'more',
): string =>
  state === 'mastered'
    ? `${name}: mastered.`
    : `${name}: ${dots} of ${need}.${state === 'tomorrow' ? ' Come back tomorrow to master it.' : ' Keep practising it.'}`;
/** The lesson counter in the shared terms: "Grammar: 3 practised · 0 mastered". */
export const grammarCounter = (practised: number, mastered: number): string =>
  `Grammar: ${practised} practised · ${mastered} ${TERM.mastered.toLowerCase()}`;
export const GRAMMAR_PICK_PROMPT = 'Which sentence is right?';
export const GRAMMAR_REORDER_PROMPT = 'Put the words in the correct order.';
export const GRAMMAR_BUILD_PROMPT = 'Build this sentence. One tile is not needed.';
export const CHECK = 'Check';

/** Phase 25: why a story was not shown, in plain words (the checker's reason keys). */
const STORY_REASON: Record<string, string> = {
  rung1: "it used too many words you haven't learned yet",
  rung3: 'it used too many words from coming lessons',
  rung4: 'it used too many words from coming lessons',
  rung5: 'it used too many words from coming lessons',
  rung6: 'it used words outside your lessons without explaining them',
  taiwanness: 'it used simplified characters or mainland wording',
  length: 'it came out much too short or too long',
  questions: "its questions didn't check out",
  'independent check': 'a second read-through found a problem',
  'new words': 'it had more new words than one short lesson can teach',
  unexplained: "it used a word we couldn't explain",
};
export const storyReasonsLine = (reasons: readonly string[]): string => {
  const parts = [...new Set(reasons.flatMap((r) => STORY_REASON[r] ?? []))];
  return parts.length === 0 ? '' : `(Not shown because ${parts.join(', and ')}.)`;
};
export const SKIP = 'Skip';

// --- Phase 28: progress saved to the server ----------------------------------------------------
const thousands = (n: number) => n.toLocaleString('en-US');
/** "today 9:58 am", "yesterday 9:58 am", "Oct 7, 9:58 am" (device time, before a profile is open). */
export const savedWhen = (iso: string | Date, now: Date = new Date(), timeZone?: string): string => {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString('en-CA', timeZone ? { timeZone } : {});
  const yesterday = new Date(now.getTime() - 86_400_000);
  const time = timeOfDay(d, timeZone);
  if (day(d) === day(now)) return `today ${time}`;
  if (day(d) === day(yesterday)) return `yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) })}, ${time}`;
};
/** "1,240 cards · 412 Learned" */
export const copyCounts = (s: { cards: number; learned: number }): string =>
  `${thousands(s.cards)} card${s.cards === 1 ? '' : 's'} · ${thousands(s.learned)} ${TERM.learned}`;
/** The restore screen while a fresh browser fills itself from the server. */
export const restoringLine = (name: string, found?: { cards: number; savedAt: string }): string =>
  `Restoring ${name}'s progress…${found ? ` found ${thousands(found.cards)} card${found.cards === 1 ? '' : 's'}, last saved ${savedWhen(found.savedAt)}` : ''}`;
export const noServerCopy = (name: string): string => `No saved progress found on the server for ${name}.`;
export const SERVER_UNREACHABLE = "Couldn't reach the server, so your saved progress couldn't be loaded.";
export const APP_OUTDATED = 'Your saved progress is from a newer version of the app. Reload to update it.';
export const TRY_AGAIN = 'Try again';
export const START_FRESH = 'Start fresh';
export const RELOAD_APP = 'Reload';
/** Header status (the cloud). */
export const SAVED = 'Saved';
export const SAVING = 'Saving…';
export const SAVE_NOW = 'Save now';
/** "Not saved for 2 h" / "Not saved for 12 min" */
export const notSavedFor = (since: Date, now: Date = new Date()): string => {
  const min = Math.max(1, Math.round((now.getTime() - since.getTime()) / 60_000));
  return min < 60 ? `Not saved for ${min} min` : `Not saved for ${Math.round(min / 60)} h`;
};
/** Why the last save failed, in words (never a dot only). */
export const SAVE_TOO_LARGE = 'Your progress is too big to save to the server. Tell Claude (server body limit).';
export const SAVE_RETRYING = 'Not saved to the server yet. Retrying.';
export const SAVE_OUTDATED = 'The server has progress from a newer version of the app. Reload to update.';
export const UNSAVED_WARNING = "Some progress isn't on the server yet.";
/** Settings → Your progress. */
export const lastSavedLine = (s: { savedAt: string; cards: number; learned: number }, now: Date = new Date()): string =>
  `Last saved to the server: ${savedWhen(s.savedAt, now)} · ${copyCounts(s)}`;
export const thisBrowserLine = (s: { cards: number; learned: number }): string => `This browser: ${copyCounts(s)}`;

// Phase 32: the Home streak bar.
export const streakLine = (current: number, best: number): string =>
  `🌱 ${current}-day streak · best ${best}`;
export const STREAK_KEEP_GROWING = 'Water something today to keep it growing';
/** The bar's spoken label: the whole sentence, and where tapping goes. */
export const streakAria = (current: number, best: number, activeToday: boolean): string =>
  `${current}-day streak, best ${best}. ${activeToday ? 'Today counts already.' : `${STREAK_KEEP_GROWING}.`} Open Progress.`;
