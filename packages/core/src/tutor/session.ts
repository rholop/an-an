// Phase 39 Parts D–E: what a saved tutoring session is, and what the rest of the app reads from it.
import { ScenarioSchema, type Scenario } from '../chat/scenario.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import { checkTaiwanness } from '../taiwanness.js';
import type { Evidence, ItemRef, Level, Word } from '../types.js';
import type { TutorDraft, TutorDraftSentence } from './draft.js';
import type { TutorClassifyRequest, TutorClassifyResponse, TutorScenarioRequest, TutorScenarioResponse } from './schema.js';
import { isLevel } from '../levels.config.js';
import { isTopicTag, scenarioTopics, topicWordTag, TOPIC_TAGS, type TopicTag } from '../topics.js';
import { TUTOR_CONFIG } from './tutor.config.js';

export interface TutorSessionWord {
  wordId: string;
  /** The card's form (traditional, Taiwan word). */
  zh: string;
  /** As printed in the notes. */
  printed: string;
  pinyin: string;
  zhuyin: string;
  pinyinNote?: string;
  mainlandForm?: string;
  alsoTaiwan?: string[];
  gloss: string;
  notesGloss?: string;
  /** Ticked on the check screen: a lesson item of this session (introduced by the study order). */
  ticked: boolean;
  custom: boolean;
  /** Phase 40 Part A: the model's estimate for a word with no official level and no estimate from
   * TBCL or its characters (custom words also carry it on their custom word). */
  estimatedLevel?: Level;
  levelSource?: 'model';
}

export interface TutorSessionGrammar {
  name: string;
  explanationEn: string;
  example: { zh: string; en: string };
  /** The app's grammar item (joins the session's Grammar step), or absent = a note only. */
  grammarId?: string;
}

export interface TutorSessionSentence {
  id: string;
  zh: string;
  en: string;
  wordId?: string;
  grammarId?: string;
  /** Checked and kept for practice (Cloze, the Grammar step); else shown with the class only. */
  practice: boolean;
}

/** One class (Dexie `tutorSessions`, synced per profile). Never holds the PDF or its images. */
export interface TutorSessionRecord {
  id: string;
  /** "YYYY-MM-DDTHH:MM", the class's local time as printed. */
  date: string;
  tutor: string;
  topics: Array<{ zh: string; en: string }>;
  words: TutorSessionWord[];
  grammar: TutorSessionGrammar[];
  sentences: TutorSessionSentence[];
  /** The class's chat scenario (made once at Save). */
  scenario?: Scenario;
  /** Phase 40 Part C: the app's topic tags of the class (its words carry them). */
  topicTags?: TopicTag[];
  /** Phase 40 Part D.1: the class's audio, as the server last answered. */
  audio?: { status: 'ok' | 'waiting_key' | 'error'; at: Date; made?: number };
  /** Phase 40: "Re-check levels and topics" (and the one-time migration) last ran. */
  recheckedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** What the study order needs of a session (core `getStudyFocus`, the ledger). */
export interface TutorLesson {
  id: string;
  date: string;
  /** Ticked words, in the notes' order. */
  wordIds: string[];
  /** Matched grammar items. */
  grammarIds: string[];
  /** Phase 40 Part C: the class's topic tags. */
  topicTags?: TopicTag[];
  /** The ticked words' headwords (Taiwan form), in `wordIds` order: scenario extras. */
  headwords?: string[];
}

export const tutorLessonOf = (s: Pick<TutorSessionRecord, 'id' | 'date' | 'words' | 'grammar'> & Partial<Pick<TutorSessionRecord, 'topicTags'>>): TutorLesson => ({
  id: s.id,
  date: s.date,
  wordIds: [...new Set(s.words.filter((w) => w.ticked).map((w) => w.wordId))],
  grammarIds: [...new Set(s.grammar.flatMap((g) => (g.grammarId ? [g.grammarId] : [])))],
  ...(s.topicTags && s.topicTags.length > 0 ? { topicTags: s.topicTags } : {}),
  headwords: [...new Set(s.words.filter((w) => w.ticked).map((w) => w.zh))],
});

/**
 * Phase 40 Part C.3: a scenario whose topics match a class's topic tags may use the class's words
 * as allowed extras (the textbook scenario rule): they join its `vocabExtras`, so its word list,
 * its Garden plot and its chat (allowed extras, targets) include them. A class's own chat and
 * scenarios with no topics are left as they are.
 */
export function withTutorExtras(scenarios: readonly Scenario[], lessons: readonly TutorLesson[], maxPerScenario = 30): Scenario[] {
  const tagged = lessons.filter((l) => (l.topicTags?.length ?? 0) > 0 && (l.headwords?.length ?? 0) > 0);
  if (tagged.length === 0) return [...scenarios];
  return scenarios.map((s) => {
    if (s.tutor) return s;
    const topics = new Set(scenarioTopics(s.id));
    if (topics.size === 0) return s;
    const add = tagged.filter((l) => l.topicTags!.some((t) => topics.has(t))).flatMap((l) => l.headwords!);
    if (add.length === 0) return s;
    const extras = [...new Set([...s.vocabExtras, ...add.slice(0, maxPerScenario)])];
    return { ...s, vocabExtras: extras };
  });
}

/** Phase 40 Part E.4: the ticked words of the latest `n` classes (newest class first): rung 2 of
 * the vocabulary ladder, the journal's suggested words, Home's story pick. */
export function recentTutorWordIds(lessons: readonly TutorLesson[], n: number): string[] {
  const latest = [...lessons].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, n);
  return [...new Set(latest.flatMap((l) => l.wordIds))];
}

/** The session's items for its "Learned X% · Mastered Y%" (ticked words, then matched grammar). */
export const tutorLessonItems = (l: TutorLesson): ItemRef[] => [
  ...l.wordIds.map((id) => ({ kind: 'word' as const, id })),
  ...l.grammarIds.map((id) => ({ kind: 'grammar' as const, id })),
];

/** Phase 40 Part E.3: the faces a tutoring word gets at Save, all at once (Meaning, Pick then
 * Recall, Say it). Listening joins once the word has a clip, like every word. */
export const TUTOR_FACES = ['recognition', 'production', 'reading'] as const;

/** Phase 39 / 40: the evidence that introduces tutoring words at Save: a New card of every face
 * (`TUTOR_FACES`) for words, a recognition card for grammar. */
export const tutorIntroduceEvidence = (
  list: ReadonlyArray<{ item: ItemRef; sessionId: string; skills?: readonly Evidence['skill'][] }>,
  at: Date,
): Evidence[] =>
  list.flatMap(({ item, sessionId, skills }) =>
    (skills ?? (item.kind === 'word' ? TUTOR_FACES : (['recognition'] as const))).map((skill) => ({
      item,
      skill,
      kind: 'textbook_lesson_covered' as const,
      at,
      context: { source: 'tutor' as const, refId: sessionId },
    })),
  );

/** The tag every word card of a session carries in its record ("tutor:<sessionId>"). */
export const tutorTag = (sessionId: string): string => `tutor:${sessionId}`;

const toSentence = (s: TutorDraftSentence): TutorSessionSentence => ({
  id: s.id,
  zh: s.zh,
  en: s.en,
  ...(s.wordId ? { wordId: s.wordId } : {}),
  ...(s.grammarId ? { grammarId: s.grammarId } : {}),
  practice: s.practice && s.checked === true,
});

/**
 * Part C "Save": the draft (with the learner's ticks) as a session record and the custom words it
 * needs. A re-upload of the same class keeps the first `createdAt` (same id, so no duplicate cards).
 */
export function finalizeTutorSession(
  draft: TutorDraft,
  opts: {
    now: Date;
    scenario?: Scenario;
    existing?: Pick<TutorSessionRecord, 'createdAt'> & Partial<Pick<TutorSessionRecord, 'audio'>>;
    /** Phase 40: the classification at Save (`applyTutorClassify`). */
    classified?: TutorClassification;
  },
): { record: TutorSessionRecord; customWords: Word[] } {
  const cls = opts.classified;
  const topicTags = [...new Set([...(draft.topicTags ?? []), ...(cls?.topicTags ?? [])])];
  const modelLevel = (key: string) => cls?.levels.get(key);
  const words: TutorSessionWord[] = draft.words.map((w) => ({
    wordId: w.wordId,
    zh: w.zh,
    printed: w.printed,
    pinyin: w.pinyin,
    zhuyin: w.zhuyin,
    ...(w.pinyinNote ? { pinyinNote: w.pinyinNote } : {}),
    ...(w.mainlandForm ? { mainlandForm: w.mainlandForm } : {}),
    ...(w.alsoTaiwan ? { alsoTaiwan: w.alsoTaiwan } : {}),
    gloss: w.gloss,
    ...(w.notesGloss ? { notesGloss: w.notesGloss } : {}),
    ticked: w.ticked,
    custom: !!w.custom,
    ...(modelLevel(w.key) ? { estimatedLevel: modelLevel(w.key)!, levelSource: 'model' as const } : {}),
  }));
  const grammar: TutorSessionGrammar[] = draft.grammar.map((g) => ({
    name: g.name,
    explanationEn: g.explanationEn,
    example: { zh: g.example.zh, en: g.example.en },
    ...(g.matchId ? { grammarId: g.matchId } : {}),
  }));
  const sentences = [...draft.words.map((w) => w.example), ...draft.grammar.map((g) => g.example)]
    .filter((s) => s.zh)
    .map(toSentence);
  return {
    record: {
      id: draft.sessionId,
      date: draft.date,
      tutor: draft.tutor,
      topics: draft.topics.map((t) => ({ zh: t.zh, en: t.en })),
      words,
      grammar,
      sentences,
      ...(opts.scenario ? { scenario: opts.scenario } : {}),
      ...(topicTags.length > 0 ? { topicTags } : {}),
      ...(opts.existing?.audio ? { audio: opts.existing.audio } : {}),
      createdAt: opts.existing?.createdAt ?? opts.now,
      updatedAt: opts.now,
    },
    // Only the ticked custom words are added (an unticked one is never studied).
    customWords: draft.words
      .filter((w) => w.custom && w.ticked)
      .map((w) => tutorCustomWord(w.custom!, draft.sessionId, topicTags, modelLevel(w.key))),
  };
}

/** A custom tutoring word with its class's tags and (if it had none) the model's level estimate. */
export function tutorCustomWord(word: Word, sessionId: string, topicTags: readonly TopicTag[], modelLevel?: Level): Word {
  const tags = [...new Set(['tutor', tutorTag(sessionId), ...word.tags, ...topicTags.map(topicWordTag)])];
  return {
    ...word,
    tags,
    ...(!word.level && !word.estimatedLevel && modelLevel ? { estimatedLevel: modelLevel, levelSource: 'model' as const } : {}),
  };
}

/** Phase 40: what the Save-time classification found (word keys → level, extra topic tags). */
export interface TutorClassification {
  levels: Map<string, Level>;
  topicTags: TopicTag[];
}

/**
 * Phase 40 Parts A.2.3 and C.1: the one classify call's request, or undefined when nothing needs it
 * (every word has a level or estimate, and every topic matched the table). `hasLevel` says whether
 * the lexicon gives a word (by id) an official level or an estimate.
 */
export function tutorClassifyRequest(
  draft: Pick<TutorDraft, 'words' | 'unmappedTopics'>,
  hasLevel: (wordId: string) => boolean,
): TutorClassifyRequest | undefined {
  const words = draft.words
    .filter((w) => w.ticked && (w.custom ? !w.custom.level && !w.custom.estimatedLevel : !hasLevel(w.wordId)))
    .map((w) => ({ zh: w.zh, en: w.gloss.slice(0, 200) }))
    .slice(0, 60);
  const topics = (draft.unmappedTopics ?? []).slice(0, 12);
  if (words.length === 0 && topics.length === 0) return undefined;
  return { words, topics, tags: [...TOPIC_TAGS] };
}

/** The answer checked against its enums: unknown levels, words and tags are dropped. */
export function applyTutorClassify(
  draft: Pick<TutorDraft, 'words'>,
  res: TutorClassifyResponse | undefined,
): TutorClassification {
  const levels = new Map<string, Level>();
  const topicTags: TopicTag[] = [];
  if (!res) return { levels, topicTags };
  for (const r of res.words) {
    const level = r.level.trim().toUpperCase();
    const w = draft.words.find((d) => d.zh === r.zh.trim());
    if (w && isLevel(level)) levels.set(w.key, level);
  }
  for (const t of res.topics) for (const tag of t.tags) if (isTopicTag(tag) && !topicTags.includes(tag)) topicTags.push(tag);
  return { levels, topicTags };
}

/** Part D.4: what the one scenario call is given. */
export function tutorScenarioRequest(draft: TutorDraft, learnerLevel: Level): TutorScenarioRequest {
  return {
    tutor: draft.tutor.slice(0, 60),
    topics: draft.topics.slice(0, 12).map((t) => ({ zh: t.zh.slice(0, 60), en: t.en.slice(0, 120) })),
    words: draft.words.filter((w) => w.ticked).map((w) => w.zh).slice(0, TUTOR_CONFIG.scenarioTargetWords),
    grammar: draft.grammar.flatMap((g) => (g.matchPattern ? [g.matchPattern.slice(0, 80)] : [])).slice(0, 12),
    learnerLevel,
  };
}

/** The scenario id of a session's chat. */
export const tutorScenarioId = (sessionId: string): string => `${sessionId}-chat`;

/**
 * Part D.4: the class's scenario, checked like scenario content (traditional characters, Taiwan
 * wording, the schema). A reply that fails, or no reply (quota), gets a plain scenario built in code
 * from the topics, so every class has its chat.
 */
export function tutorScenario(
  draft: Pick<TutorDraft, 'sessionId' | 'tutor' | 'topics' | 'words'>,
  res: TutorScenarioResponse | undefined,
): Scenario {
  const id = tutorScenarioId(draft.sessionId);
  const tutor = draft.tutor || 'your tutor';
  const topic = draft.topics[0] ?? { zh: '今天的課', en: "today's class" };
  const vocabExtras = draft.words.filter((w) => w.ticked).map((w) => w.zh);
  const clean = (...zh: string[]) => zh.every((z) => z.trim() && checkTaiwanness(z).isClean);
  const base = {
    id,
    levelRange: { min: 'N1' as const, max: 'L5' as const },
    vocabExtras,
    tutor: { sessionId: draft.sessionId },
  };
  if (res && clean(res.opener.zh, res.successLine.zh, ...res.goalSteps.flatMap((g) => g.keywordHints))) {
    const parsed = ScenarioSchema.safeParse({
      ...base,
      title: res.title,
      npc: { id: `${id}-npc`, name: res.npcName || tutor, personality: res.personality, speechStyle: res.speechStyle, particles: [] },
      setting: res.setting,
      goalSteps: res.goalSteps.map((g, i) => ({ id: `step${i + 1}`, description: g.description, keywordHints: g.keywordHints })),
      opener: res.opener,
      successLine: res.successLine,
    });
    if (parsed.success) return parsed.data;
  }
  return ScenarioSchema.parse({
    ...base,
    title: `Chat about ${topic.en}`,
    npc: {
      id: `${id}-npc`,
      name: tutor,
      personality: `${tutor}, your patient Mandarin tutor, curious about your life and happy to repeat things.`,
      speechStyle: 'Short, clear Taiwan Mandarin sentences; one question at a time.',
      particles: [],
    },
    setting: `A follow-up chat after your class with ${tutor} about ${draft.topics.map((t) => t.en).join(', ') || 'what you learned'}.`,
    goalSteps:
      draft.topics.length > 0
        ? draft.topics.slice(0, 3).map((t, i) => ({ id: `step${i + 1}`, description: `Talk about ${t.en}`, keywordHints: [] as string[] }))
        : [{ id: 'step1', description: 'Use two words from the class', keywordHints: vocabExtras.slice(0, 4) }],
    opener: { zh: `我們來聊聊「${topic.zh}」吧！你今天怎麼樣？`, en: `Let's talk about "${topic.en}"! How are you today?` },
    successLine: { zh: '你說得很好！下次上課見。', en: 'You did really well! See you next class.' },
  });
}

/**
 * Part D.3: a session's kept, checked sentences as sentence-bank entries for Cloze, labelled
 * "from your class with Carl".
 */
export function tutorClozeSentences(session: TutorSessionRecord, level: (wordId: string) => Level | null | undefined): SentenceBankEntry[] {
  return session.sentences
    .filter((s) => s.practice && s.wordId)
    .map((s) => ({
      id: s.id,
      zh: s.zh,
      en: s.en,
      targetWordId: s.wordId!,
      level: level(s.wordId!) ?? 'N1',
      tokens: [],
      source: 'tutor' as const,
      doubtful: false,
      tags: [tutorTag(session.id)],
      sourceLabel: `${TUTOR_CONFIG.clozeLabelPrefix} ${session.tutor || 'your tutor'}`,
      ...(s.grammarId ? { grammarIds: [s.grammarId] } : {}),
    }));
}

const JOURNAL_TOPIC_PROMPTS: Partial<Record<TopicTag, string>> = {
  food: 'Write 3 sentences about what you ate today',
  health: 'Write 3 sentences about the last time you felt unwell',
  places: 'Write 3 sentences about places near your home',
  transport: 'Write 3 sentences about how you get around',
  shopping: 'Write 3 sentences about something you bought recently',
  family: 'Write 3 sentences about your family',
  work: 'Write 3 sentences about your work',
  school: 'Write 3 sentences about your studies',
  travel: 'Write 3 sentences about a trip you took or want to take',
  home: 'Write 3 sentences about your home',
  hobbies: 'Write 3 sentences about what you like to do',
  weather: 'Write 3 sentences about the weather this week',
  time: 'Write 3 sentences about your day',
  money: 'Write 3 sentences about prices where you live',
  language: 'Write 3 sentences about learning Mandarin',
  people: 'Write 3 sentences about a friend',
};

/** The journal prompt id of a class ("<sessionId>-journal"). */
export const tutorJournalPromptId = (sessionId: string): string => `${sessionId}-journal`;

/**
 * Phase 40 Part D.3: the class's Journal step: a prompt from its topics that asks for its words
 * ("Write 3 sentences about what you ate today using 早餐, 宵夜, 點心"), words not Learned first.
 */
export function tutorJournalPrompt(
  rec: Pick<TutorSessionRecord, 'id' | 'tutor' | 'words' | 'grammar' | 'topicTags' | 'topics'>,
  learned: (wordId: string) => boolean = () => false,
): { id: string; lessonId: string; promptEn: string; useWords: string[]; useGrammar: string[] } {
  const ticked = rec.words.filter((w) => w.ticked);
  const ordered = [...ticked.filter((w) => !learned(w.wordId)), ...ticked.filter((w) => learned(w.wordId))].slice(0, 3);
  const lead =
    (rec.topicTags ?? []).map((t) => JOURNAL_TOPIC_PROMPTS[t]).find(Boolean) ??
    `Write 3 sentences about ${rec.topics[0]?.en.toLowerCase() || `your class with ${rec.tutor || 'your tutor'}`}`;
  return {
    id: tutorJournalPromptId(rec.id),
    lessonId: rec.id,
    promptEn: ordered.length > 0 ? `${lead} using ${ordered.map((w) => w.zh).join(', ')}.` : `${lead}.`,
    useWords: ordered.map((w) => w.wordId),
    useGrammar: [...new Set(rec.grammar.flatMap((g) => (g.grammarId ? [g.grammarId] : [])))].slice(0, 1),
  };
}
