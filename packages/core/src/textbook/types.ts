// Phase 12: class textbook curriculum (來學華語 第一冊). Shapes are the
// contract between the importer (data-pipeline), the proxy and the web app.
import type { Level } from '../levels.config.js';

export interface JournalPrompt {
  id: string;
  lessonId: string;
  promptEn: string;
  promptZh?: string;
  /** Word ids the learner is invited to use. */
  useWords: string[];
  /** Grammar item ids. */
  useGrammar: string[];
  /** Phase 13: app level of the prompt (from its book/lesson). */
  level?: Level;
}

export interface Lesson {
  /** 'laixue-1-L03' */
  id: string;
  /** 1–10 (position inside its book) */
  n: number;
  titleZh: string;
  titleEn: string;
  /** 'Occupations (I)' */
  topic: string;
  /** Objectives page, in English. */
  objectives: string[];
  /** Word ids: core 生詞 + 短語. */
  vocab: string[];
  /** 補充生詞 word ids — lower priority, not required for "lesson done". */
  supplementary: string[];
  /** Function words the lesson's grammar points introduce (的, 呢, 星期一…): word ids. */
  grammarWords?: string[];
  /** Names/places (validator whitelist). */
  properNouns: string[];
  /** GrammarItem ids. */
  grammar: string[];
  /** Pointer into private/dialogues.json. */
  dialogueRef: string;
  /** Scenario ids built for this lesson. */
  scenarios: string[];
  journalPrompts: JournalPrompt[];
}

export interface Textbook {
  id: string;
  titleZh: string;
  titleEn: string;
  lessons: Lesson[];
}

/** Textbook structure as shipped to the app (`book.json`; safe to commit). */
export interface TextbookFile {
  meta: { version: string; buildDate: string };
  textbook: Textbook;
}

/** The book's own gloss for a word, shown first in textbook context. */
export interface TextbookWordNote {
  wordId: string;
  lesson: number;
  glossEn: string;
}

/** Per-profile, synced "My class" setting. */
export interface MyClassSetting {
  enabled: boolean;
  textbookId: string;
  /** Position inside `textbookId` (1–10): the lesson the class is currently on. */
  currentLesson: number;
}

export const DEFAULT_MY_CLASS: MyClassSetting = {
  enabled: false,
  textbookId: 'laixue-1',
  currentLesson: 1,
};
