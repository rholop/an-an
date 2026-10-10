// Phase 24: one StoryService per lexicon, the per-profile difficulty, and the background
// "keep 2 ready" step shared by Home and the Reader.
import { useEffect, useMemo } from 'react';
import { LessonStoriesFileSchema, LessonStorySchema, type LessonStory, type Lexicon, type Level, type StoryDifficulty, type StoryLLM, type StoryRecord, type Textbook } from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import { getSiteCode } from './api.js';
import { FakeStoryLLM } from './fake-story-llm.js';
import { cachedTopicWords } from './open-chat-service.js';
import { getStudyBooks, getStudyFocusNow } from './study.js';
import { fetchPrivateTextbook } from './textbook-data.js';
import { StoryService } from './story-service.js';
import { FetchTutorLLM } from './tutor-llm.js';
import { useSetting } from './useSetting.js';

/** Dev only: write stories with the no-network fake (the Stories section has the switch). */
export const FAKE_STORY_KEY = 'anan.stories.fake';
export const storyFakeOn = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(FAKE_STORY_KEY) === '1';
  } catch {
    return false;
  }
};

const storyLLM = (fake: boolean): StoryLLM => (fake ? new FakeStoryLLM() : new FetchTutorLLM());

/** Writing needs the household code (Phase 8); dev and the fake need nothing. */
export const canWriteStories = (fake = storyFakeOn()): boolean => fake || import.meta.env.DEV || Boolean(getSiteCode());

export function useStoryService(lexicon: Lexicon, fake = storyFakeOn()): StoryService {
  return useOptionalStoryService(lexicon, fake)!;
}

/** The same, before the lexicon has loaded (Home). */
export function useOptionalStoryService(lexicon: Lexicon | null, fake = storyFakeOn()): StoryService | null {
  return useMemo(
    () =>
      lexicon
        ? new StoryService(db, lexicon, learnerService, storyLLM(fake), {
            books: () => getStudyBooks(),
            studyFocus: () => getStudyFocusNow(),
            topicWords: (topic, level) => cachedTopicWords(db, topic, level),
            lessonStories,
          })
        : null,
    [lexicon, fake],
  );
}

/** Phase 26 Part E: the stories written ahead for a book's lessons (private lesson data).
 * Phase 30 Part B.2: fetched again on each Stories visit (the proxy answers 304 when nothing
 * changed), so stories written while the app is open show up without a reload. One fetch serves a
 * few seconds of calls (one "Next story" asks for several lessons). */
const LESSON_STORIES_FRESH_MS = 5_000;
const lessonStoryFiles = new Map<string, { at: number; stories: Promise<readonly LessonStory[]> }>();
function lessonStories(bookId: string): Promise<readonly LessonStory[]> {
  const hit = lessonStoryFiles.get(bookId);
  if (hit && Date.now() - hit.at < LESSON_STORIES_FRESH_MS) return hit.stories;
  const stories = fetchPrivateTextbook<unknown>('stories', bookId).then((r) => {
    if (r.status !== 'ok') return [];
    const parsed = LessonStoriesFileSchema.safeParse(r.data);
    if (parsed.success) return parsed.data.stories;
    // One bad entry never hides the rest of the book's stories
    const rows = (r.data as { stories?: unknown } | null)?.stories;
    return Array.isArray(rows) ? rows.flatMap((row) => {
      const one = LessonStorySchema.safeParse(row);
      return one.success ? [one.data] : [];
    }) : [];
  });
  lessonStoryFiles.set(bookId, { at: Date.now(), stories });
  return stories;
}

/** Easier / Just right / Harder, remembered per profile. */
export function useStoryDifficulty(): [StoryDifficulty, (d: StoryDifficulty) => void] {
  const [d, setD] = useSetting<StoryDifficulty>('storyDifficulty', 'middle');
  return [d === 'easier' || d === 'harder' ? d : 'middle', setD];
}

/** Phase 25: open chats (scenario or open chat). Background stories wait while any is open, so
 * the free Gemini quota goes to the conversation first. */
let chatting = 0;
export function useChatPausesStories(): void {
  useEffect(() => {
    chatting++;
    return () => {
      chatting--;
    };
  }, []);
}
export const chatIsOpen = (): boolean => chatting > 0;

const prepared = new Set<string>();
/** Keeps two stories ready for the current lesson (written one at a time, never while a chat is
 * open), once per lesson / level / difficulty per visit. */
export function prepareStories(service: StoryService, level: Level, difficulty: StoryDifficulty, lessonKey: string): void {
  if (!canWriteStories() || chatIsOpen()) return;
  // Automated browsers (the e2e specs) never write in the background, except with the fake writer.
  if (typeof navigator !== 'undefined' && navigator.webdriver && !storyFakeOn()) return;
  const key = `${level}|${difficulty}|${lessonKey}|${storyFakeOn() ? 'fake' : 'live'}`;
  if (prepared.has(key)) return;
  prepared.add(key);
  void service
    .ensureReady(level, difficulty, new Date(), () => !chatIsOpen())
    .then(() => {
      // paused by a chat: try again on the next visit
      if (chatIsOpen()) prepared.delete(key);
    })
    .catch(() => undefined);
}

/** The book and lesson number a story was written for (for its badge). */
export function storyLesson(story: Pick<StoryRecord, 'lessonId'>, books: Textbook[] = getStudyBooks()): { bookId: string; n: number } | undefined {
  if (!story.lessonId) return undefined;
  for (const b of books) {
    const l = b.lessons.find((x) => x.id === story.lessonId);
    if (l) return { bookId: b.id, n: l.n };
  }
  return undefined;
}
