// Phase 24: one StoryService per lexicon, the per-profile difficulty, and the background
// "keep 2 ready" step shared by Home and the Reader.
import { useEffect, useMemo } from 'react';
import type { Lexicon, Level, StoryDifficulty, StoryLLM, StoryRecord, Textbook } from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import { getSiteCode } from './api.js';
import { FakeStoryLLM } from './fake-story-llm.js';
import { getStudyBooks, getStudyFocusNow } from './study.js';
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
          })
        : null,
    [lexicon, fake],
  );
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
