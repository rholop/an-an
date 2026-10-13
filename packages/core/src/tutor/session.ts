// Phase 39 Parts D–E: what a saved tutoring session is, and what the rest of the app reads from it.
import { ScenarioSchema, type Scenario } from '../chat/scenario.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import { checkTaiwanness } from '../taiwanness.js';
import type { Evidence, ItemRef, Level, Word } from '../types.js';
import type { TutorDraft, TutorDraftSentence } from './draft.js';
import type { TutorScenarioRequest, TutorScenarioResponse } from './schema.js';
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
}

export const tutorLessonOf = (s: Pick<TutorSessionRecord, 'id' | 'date' | 'words' | 'grammar'>): TutorLesson => ({
  id: s.id,
  date: s.date,
  wordIds: [...new Set(s.words.filter((w) => w.ticked).map((w) => w.wordId))],
  grammarIds: [...new Set(s.grammar.flatMap((g) => (g.grammarId ? [g.grammarId] : [])))],
});

/** The session's items for its "Learned X% · Mastered Y%" (ticked words, then matched grammar). */
export const tutorLessonItems = (l: TutorLesson): ItemRef[] => [
  ...l.wordIds.map((id) => ({ kind: 'word' as const, id })),
  ...l.grammarIds.map((id) => ({ kind: 'grammar' as const, id })),
];

/** Phase 39: the evidence that introduces tutoring words as New cards (at Save, and first thing in a
 * later session for an upload over the per-session limit). */
export const tutorIntroduceEvidence = (
  list: ReadonlyArray<{ item: ItemRef; sessionId: string }>,
  at: Date,
): Evidence[] =>
  list.map(({ item, sessionId }) => ({
    item,
    skill: 'recognition',
    kind: 'textbook_lesson_covered',
    at,
    context: { source: 'tutor', refId: sessionId },
  }));

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
  opts: { now: Date; scenario?: Scenario; existing?: Pick<TutorSessionRecord, 'createdAt'> },
): { record: TutorSessionRecord; customWords: Word[] } {
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
      createdAt: opts.existing?.createdAt ?? opts.now,
      updatedAt: opts.now,
    },
    // Only the ticked custom words are added (an unticked one is never studied).
    customWords: draft.words.filter((w) => w.custom && w.ticked).map((w) => w.custom!),
  };
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
