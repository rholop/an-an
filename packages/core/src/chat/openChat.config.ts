import type { Level } from '../levels.config.js';

/** Phase 18 "Open chat": every number lives here (nothing is hardcoded in the
 * tiering, validator, prompt-sampling or UI code). */
export interface OpenChatConfig {
  upcomingLessons: number;
  levelStepWordCap: number;
  tierBIncludesLowerLevels: boolean;
  limits: { tierAMinShare: number; tierBMaxTokens: number; tierCMaxTokens: number };
  maxRegenerations: number;
  topicWordCount: number;
  prompt: { tierASample: number; tierBTopicMax: number; tierATopicMax: number; tierCTopicMax: number };
  hardTopicTierCWords: number;
  history: { recentTurns: number; summaryEveryTurns: number; summaryMaxChars: number };
  chips: { count: number; maxFromLessons: number };
}

export const OPEN_CHAT_CONFIG: OpenChatConfig = {
  /** The active lesson plus this many − 1 following ones. */
  upcomingLessons: 3,
  /** "the rest of a TOCFL level" step: at most this many of its unmastered words count as upcoming. */
  levelStepWordCap: 40,
  /** Tier B also covers the levels BELOW the picked one (words you have not met yet
   * but that are not "advanced"). false = the picked level only. */
  tierBIncludesLowerLevels: true,

  /** Validator limits (Part C). */
  limits: {
    /** Tier A ≥ this share of content tokens. */
    tierAMinShare: 0.85,
    tierBMaxTokens: 3,
    tierCMaxTokens: 1,
  },
  /** Regenerations after the first attempt ("regenerate once"). */
  maxRegenerations: 1,

  /** Topic word list (one cached call per topic + level). */
  topicWordCount: 60,
  /** What the prompt receives. */
  prompt: {
    tierASample: 150,
    tierBTopicMax: 60,
    tierATopicMax: 60,
    tierCTopicMax: 5,
  },
  /** A topic is "hard" when at least this many of its words are tier C. */
  hardTopicTierCWords: 12,

  /** Long chats: last N turns + a running summary refreshed every M turns. */
  history: { recentTurns: 12, summaryEveryTurns: 6, summaryMaxChars: 900 },

  chips: {
    count: 8,
    /** How many of the chips may come from the upcoming lessons' themes. */
    maxFromLessons: 4,
  },
};

export interface DefaultTopic {
  id: string;
  label: string;
  /** English or Chinese text sent as the topic. */
  topic: string;
  /** Easiest level at which the topic makes sense (chips for higher ones stay hidden). */
  minLevel: Level;
}

/** Fallback chips, shown in this order when the upcoming lessons do not fill all eight. */
export const DEFAULT_TOPICS: readonly DefaultTopic[] = [
  { id: 'food', label: 'Food you like', topic: 'food you like', minLevel: 'N1' },
  { id: 'family', label: 'Family', topic: 'family', minLevel: 'N1' },
  { id: 'weekend', label: 'Your weekend', topic: 'your weekend', minLevel: 'N1' },
  { id: 'drinks', label: 'Drinks and tea', topic: 'drinks and tea', minLevel: 'N1' },
  { id: 'weather', label: 'The weather', topic: 'the weather', minLevel: 'N1' },
  { id: 'daily', label: 'Your day', topic: 'your daily routine', minLevel: 'N2' },
  { id: 'hobbies', label: 'Hobbies', topic: 'hobbies', minLevel: 'N2' },
  { id: 'friends', label: 'Friends', topic: 'friends', minLevel: 'N2' },
  { id: 'shopping', label: 'Shopping', topic: 'shopping', minLevel: 'L1' },
  { id: 'travel', label: 'Travel', topic: 'travel and trips', minLevel: 'L1' },
  { id: 'transport', label: 'Getting around Taipei', topic: 'getting around Taipei', minLevel: 'L1' },
  { id: 'work', label: 'Work', topic: 'work', minLevel: 'L2' },
  { id: 'school', label: 'School and study', topic: 'school and study', minLevel: 'L2' },
  { id: 'health', label: 'Health', topic: 'health', minLevel: 'L2' },
  { id: 'movies', label: 'Movies and shows', topic: 'movies and shows', minLevel: 'L3' },
  { id: 'news', label: 'The news', topic: 'news', minLevel: 'L4' },
];

/** "Just chat": the first NPC line is authored, like scenario openers. */
export const OPEN_CHAT_OPENERS: readonly { zh: string; en: string; maxLevel?: Level }[] = [
  { zh: '你好！你今天怎麼樣？', en: 'Hi! How are you today?' },
  { zh: '嗨！你今天做了什麼？', en: 'Hey! What did you do today?' },
  { zh: '你好！你吃飯了嗎？', en: 'Hi! Have you eaten yet?' },
];

/** The lead-in once a topic is chosen. {topic} is replaced with the text the learner entered. */
export const OPEN_CHAT_TOPIC_OPENER = {
  zh: '好啊，我們來聊聊吧！你先說。',
  en: "Sure, let's chat! You go first.",
};

export const OPEN_CHAT_NPC = { id: 'anan', name: '安安' } as const;
