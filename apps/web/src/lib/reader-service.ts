import {
  bankEntryToReaderSentence,
  buildReaderGenRequest,
  evaluateReaderSentence,
  hashReaderText,
  levelIndex,
  PRIORITY_CONFIG,
  type StudyFocus,
  lessonBadge,
  lessonTag,
  nextNewItems,
  pickFromEvaluated,
  pickGenerationWord,
  readerSentencesFromChat,
  readerSentencesFromJournal,
  selectLocalReaderSentence,
  type ClassScope,
  type Evidence,
  type Level,
  type Lexicon,
  type ReaderFocus,
  type ReaderLearnerState,
  type ReaderPick,
  type Scenario,
  type SentenceBankEntry,
  type SkillCard,
  type TutorLLM,
} from '@anan/core';
import { allChatLines, allJournalSentences, allTouchedCards } from '../db/queries.js';
import type { AnanDB, LiveSentenceRow } from '../db/schema.js';
import type { LearnerService } from './learner-service.js';

/** How many frontier words to consider for the "New words" focus. */
const FRONTIER_POOL = 60;

export interface ReaderDeps {
  db: AnanDB;
  learnerService: LearnerService;
  lexicon: Lexicon;
  /** Only `generateSentences` is used. Omit (or make it throw) to stay offline. */
  llm?: Pick<TutorLLM, 'generateSentences'>;
  /** The Phase 4 bank for the levels loaded so far (may be empty). */
  staticBank: readonly SentenceBankEntry[];
  scenarios: readonly Scenario[];
  /** Live generation needs the household code (phase 8); the page says whether one is set. */
  canGenerate?: () => boolean;
  rand?: () => number;
  /** Phase 12: sentences written for the class's current lesson (the "Lesson" focus). */
  lesson?: { bookId: string; n: number; sentences: readonly SentenceBankEntry[] };
  /** Phase 12: keeps textbook words from lessons beyond current+1 out of the "New words" frontier. */
  classScope?: ClassScope;
  /** Phase 14: the study order's focus (the "Lesson" focus is built around unmastered items). */
  studyFocus?: () => Promise<StudyFocus | undefined>;
  /** Phase 14: item key ("word:id") → lesson id, to find the lesson an item belongs to. */
  lessonIndex?: ReadonlyMap<string, string>;
  /** Phase 14: sentences of every imported book. */
  textbookSentences?: readonly SentenceBankEntry[];
}

export interface NextSentenceRequest {
  focus: ReaderFocus;
  level: Level;
  /** Sentence ids already in this session's history — never offered again straight away. */
  sessionIds?: ReadonlySet<string>;
  /** Skip the network (used by nothing today; handy for tests). */
  allowLive?: boolean;
  now?: Date;
}

export interface NextSentenceResult {
  pick: ReaderPick;
  /** True when this came from the live generator rather than a local pool. */
  generated: boolean;
}

export type ReaderEvidenceKind = 'chat_lookup_gloss' | 'chat_hover_reading';

/**
 * Phase 9: the reader's "New sentence" button. Order: sentence bank -> the
 * learner's own chat/journal lines -> live generation through the proxy (only
 * if the first two have no exact match) -> a repeat or the closest match.
 * Everything the model returns is validated in code before it is shown or saved.
 */
export class ReaderService {
  constructor(private readonly deps: ReaderDeps) {}

  /** The learner's current picture, read fresh each press (cheap, and a level
   * change or a lookup a moment ago is reflected immediately). */
  async learnerState(level: Level, now: Date): Promise<ReaderLearnerState> {
    const { db, learnerService, lexicon } = this.deps;
    const [knownIds, cards] = await Promise.all([learnerService.knownSet('review'), allTouchedCards(db)]);
    const recognition = cards.filter((c: SkillCard) => c.skill === 'recognition' && c.item.kind === 'word');
    const dueIds = new Set(recognition.filter((c) => c.card.due <= now).map((c) => c.item.id));
    const learningIds = new Set(
      recognition.filter((c) => c.state === 'learning' || c.state === 'introduced').map((c) => c.item.id),
    );
    const frontier = nextNewItems(cards, lexicon, FRONTIER_POOL, {
      currentLevel: level,
      ...(this.deps.classScope?.enabled ? { classScope: this.deps.classScope } : {}),
    });
    return { lexicon, learnerLevel: level, knownIds, dueIds, learningIds, frontier };
  }

  private async shownMap(sessionIds: ReadonlySet<string>, now: Date): Promise<Map<string, number>> {
    const rows = await this.deps.db.readerShown.toArray();
    const shown = new Map(rows.map((r) => [r.sentenceId, r.at.getTime()]));
    for (const id of sessionIds) shown.set(id, now.getTime());
    return shown;
  }

  /** "Lesson" focus: only sentences tagged with the current lesson, least
   * recently shown first (never a live-generated or out-of-lesson one). */
  /**
   * Phase 14: a sentence built around ONE unmastered item of the active lesson (about
   * `reviewLessonShare` of the time a weak item of a review lesson instead). Level-picker
   * exempt: the active step shows whatever the picker says.
   */
  private async nextStudySentence(
    sf: StudyFocus,
    req: NextSentenceRequest,
    now: Date,
  ): Promise<NextSentenceResult | null> {
    const all = this.deps.textbookSentences ?? this.deps.lesson?.sentences ?? [];
    const idx = this.deps.lessonIndex;
    if (!idx || all.length === 0) return null;
    const rand = this.deps.rand ?? Math.random;
    const useReview = sf.reviewItems.length > 0 && rand() < PRIORITY_CONFIG.reviewLessonShare;
    const items = useReview ? sf.reviewItems : sf.focusItems;
    const shown = await this.shownMap(req.sessionIds ?? new Set(), now);
    // Walk the items in order (book order, starting at a random offset among the first few)
    // until one has a sentence.
    const start = Math.floor(rand() * Math.min(items.length, 3));
    for (let k = 0; k < items.length; k++) {
      const item = items[(start + k) % items.length]!;
      const lessonId = idx.get(`${item.kind}:${item.id}`);
      const m = lessonId ? /^(laixue-\d+)-L(\d+)$/.exec(lessonId) : null;
      if (!m) continue;
      const bookId = m[1]!;
      const n = Number(m[2]);
      const headword = item.kind === 'word' ? this.deps.lexicon.byId(item.id)?.headword : undefined;
      const pool = all.filter(
        (s) =>
          s.lesson === n &&
          (s.textbookId ?? 'laixue-1') === bookId &&
          (item.kind === 'grammar'
            ? (s.grammarIds ?? []).includes(item.id)
            : headword !== undefined && s.zh.includes(headword)),
      );
      if (pool.length === 0) continue;
      const unseen = pool.filter((s) => !shown.has(s.id));
      const choices = unseen.length > 0 ? unseen : [...pool].sort((a, b) => (shown.get(a.id) ?? 0) - (shown.get(b.id) ?? 0)).slice(0, 3);
      const entry = choices[Math.floor(rand() * choices.length)]!;
      return {
        generated: false,
        pick: {
          sentence: { ...bankEntryToReaderSentence(entry), sourceLabel: lessonBadge(n, bookId) },
          focus: 'lesson',
          focusWordId: item.kind === 'word' ? item.id : entry.targetWordId,
          reason: `Studying ${lessonBadge(n, bookId)}${useReview ? ' (review)' : ''}`,
          exact: true,
          coverage: 1,
          unknownCount: 0,
        },
      };
    }
    return null;
  }

  private async nextLessonSentence(req: NextSentenceRequest, now: Date): Promise<NextSentenceResult | null> {
    const sf = await this.deps.studyFocus?.().catch(() => undefined);
    if (sf?.enabled) {
      const r = await this.nextStudySentence(sf, req, now);
      if (r) return r;
      // The active step is a TOCFL level: the frontier ("new words") of that level is the lesson.
      if (!sf.activeLesson) return this.next({ ...req, focus: 'new' });
    }
    const lesson = this.deps.lesson;
    if (!lesson) return null;
    const rand = this.deps.rand ?? Math.random;
    const tag = lessonTag(lesson.n, lesson.bookId);
    // Phase 13: the header level hides sentences harder than the chosen level.
    const pool = lesson.sentences.filter(
      (s) =>
        s.lesson === lesson.n &&
        (s.tags ?? []).includes(tag) &&
        levelIndex(s.level) <= levelIndex(req.level),
    );
    if (pool.length === 0) return null;
    const shown = await this.shownMap(req.sessionIds ?? new Set(), now);
    const unseen = pool.filter((s) => !shown.has(s.id));
    const choices = unseen.length > 0 ? unseen : [...pool].sort((a, b) => (shown.get(a.id) ?? 0) - (shown.get(b.id) ?? 0)).slice(0, 5);
    const entry = choices[Math.floor(rand() * choices.length)]!;
    const sentence = { ...bankEntryToReaderSentence(entry), sourceLabel: lessonBadge(lesson.n, lesson.bookId) };
    return {
      generated: false,
      pick: {
        sentence,
        focus: 'lesson',
        focusWordId: entry.targetWordId,
        reason: `Lesson ${lesson.n} sentence`,
        exact: true,
        coverage: 1,
        unknownCount: 0,
      },
    };
  }

  async next(req: NextSentenceRequest): Promise<NextSentenceResult | null> {
    const { db } = this.deps;
    const now = req.now ?? new Date();
    const rand = this.deps.rand ?? Math.random;
    if (req.focus === 'lesson') return this.nextLessonSentence(req, now);
    const state = await this.learnerState(req.level, now);
    const [live, chat, journal] = await Promise.all([
      db.liveSentences.toArray(),
      allChatLines(db, [...this.deps.scenarios]),
      allJournalSentences(db),
    ]);
    const shown = await this.shownMap(req.sessionIds ?? new Set(), now);
    const own = [...readerSentencesFromJournal(journal), ...readerSentencesFromChat(chat)];

    const local = selectLocalReaderSentence({
      state,
      focus: req.focus,
      bank: [...this.deps.staticBank, ...live],
      own,
      shown,
      now,
      rand,
    });
    if (local.exact) return { pick: local.exact, generated: false };

    if (req.allowLive !== false) {
      const generated = await this.generate(req.focus, state, shown, now);
      if (generated) return { pick: generated, generated: true };
    }
    const fallback = local.repeatExact ?? local.closest;
    return fallback ? { pick: fallback, generated: false } : null;
  }

  /** Ask the proxy for 3 candidates, show the first that passes, save it. A
   * network failure, a missing code or zero passes all just return null. */
  private async generate(
    focus: ReaderFocus,
    state: ReaderLearnerState,
    shown: ReadonlyMap<string, number>,
    now: Date,
  ): Promise<ReaderPick | null> {
    const { llm, db } = this.deps;
    if (!llm?.generateSentences || this.deps.canGenerate?.() === false) return null;
    const rand = this.deps.rand ?? Math.random;
    const word = pickGenerationWord(focus, state, rand);
    if (!word) return null;
    let response;
    try {
      response = await llm.generateSentences(buildReaderGenRequest(word, state, rand));
    } catch {
      return null;
    }
    for (const candidate of response.sentences) {
      const zh = candidate.zh.trim();
      const id = `live-${hashReaderText(zh)}`;
      if (!zh || shown.has(id)) continue;
      const evaluation = evaluateReaderSentence(zh, focus, state);
      if (!evaluation.exact) continue; // failed validation: never shown, never saved
      const row: LiveSentenceRow = {
        id,
        zh,
        en: candidate.en,
        targetWordId: word.id,
        level: word.level ?? state.learnerLevel,
        tokens: candidate.tokens,
        source: 'generated-live',
        doubtful: false,
        createdAt: now,
      };
      await db.liveSentences.put(row);
      return pickFromEvaluated(bankEntryToReaderSentence(row), focus, evaluation, state);
    }
    return null;
  }

  /** Remember that this profile has now seen the sentence (7-day no-repeat rule). */
  async markShown(sentenceId: string, at: Date = new Date()): Promise<void> {
    await this.deps.db.readerShown.put({ sentenceId, at });
  }

  /** A tap (gloss) or a hover-to-reveal (reading) on a word, tagged as reader evidence. */
  async recordLookup(
    wordId: string,
    kind: ReaderEvidenceKind,
    sentenceId: string | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    await this.deps.learnerService.record(
      {
        item: { kind: 'word', id: wordId },
        skill: 'recognition',
        kind,
        at: now,
        context: { source: 'reader', refId: sentenceId },
      },
      now,
    );
  }

  /**
   * Leaving a sentence: every due or learning word in it that the learner did
   * NOT look up was read without help -> chat_read_no_lookup (phase 3's rule).
   */
  async recordNoLookup(
    wordIds: readonly string[],
    lookedUp: ReadonlySet<string>,
    sentenceId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const events: Evidence[] = [];
    for (const wordId of new Set(wordIds)) {
      if (lookedUp.has(wordId)) continue;
      const card = await this.deps.learnerService.getCard({ kind: 'word', id: wordId }, 'recognition');
      if (!card) continue;
      if (card.state === 'learning' || card.card.due <= now) {
        events.push({
          item: { kind: 'word', id: wordId },
          skill: 'recognition',
          kind: 'chat_read_no_lookup',
          at: now,
          context: { source: 'reader', refId: sentenceId },
        });
      }
    }
    if (events.length > 0) await this.deps.learnerService.recordBulk(events, now);
    return events.length;
  }

  /**
   * "Show English" is a weak lookup: it counts the same as tapping each of the
   * sentence's unknown words (anything not yet known and not already looked up).
   * Returns the word ids it recorded, so the page can treat them as looked up.
   */
  async recordRevealEnglish(
    wordIds: readonly string[],
    lookedUp: ReadonlySet<string>,
    sentenceId: string,
    now: Date = new Date(),
  ): Promise<string[]> {
    const known = await this.deps.learnerService.knownSet('review');
    const unknown = [...new Set(wordIds)].filter((id) => !known.has(id) && !lookedUp.has(id));
    if (unknown.length === 0) return [];
    await this.deps.learnerService.recordBulk(
      unknown.map<Evidence>((id) => ({
        item: { kind: 'word', id },
        skill: 'recognition',
        kind: 'chat_lookup_gloss',
        at: now,
        context: { source: 'reader', refId: sentenceId },
      })),
      now,
    );
    return unknown;
  }
}
