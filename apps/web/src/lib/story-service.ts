// Phase 24: graded stories. Builds the request from the vocabulary ladder, writes the story through
// the proxy, validates it in code (rung shares, Taiwan / traditional, length, questions), has the
// other provider read it independently, and keeps it in the profile's synced library. A story that
// fails is never shown: STORY_UNAVAILABLE ("Couldn't write a story right now. Try again.").
import {
  analyzeStory,
  runStoryPipeline,
  storyAllowedNames,
  storyPromptLists,
  type LessonStory,
  type StoryStage,
  storyBudget,
  promptBudget,
  rereadSuggestions,
  storyLength,
  storyReadingStats,
  storyRecord,
  storyRequestKey,
  vocabLadder,
  glossFor,
  STORY_CONFIG,
  type Evidence,
  type Lexicon,
  type Level,
  type StoryDifficulty,
  type StoryLLM,
  type StoryRecord,
  type StoryRequest,
  type StudyFocus,
  type Textbook,
  type VocabLadder,
  type VocabRung,
  type WordSets,
} from '@anan/core';
import type { AnanDB } from '../db/schema.js';
import type { LearnerService } from './learner-service.js';

export class StoryUnavailableError extends Error {
  constructor(readonly reasons: string[] = []) {
    super("Couldn't write a good story right now");
    this.name = 'StoryUnavailableError';
  }
}

/** What the page supplies fresh on every call (a changed class lesson applies at once). */
export interface StoryEnvironment {
  books(): Textbook[];
  studyFocus?(): Promise<StudyFocus | undefined>;
  /** Phase 26: the topic's words (Phase 18's cached list), so the prompt lists them first. */
  topicWords?(topic: string, level: Level): Promise<readonly string[]>;
  /** Phase 26 Part E: the stories written ahead for a book's lessons (private lesson data). */
  lessonStories?(bookId: string): Promise<readonly LessonStory[]>;
}

export type StoryTopicKind = 'lesson' | 'journal' | 'typed' | 'chip' | 'continue';

export interface StoryAsk {
  level: Level;
  difficulty: StoryDifficulty;
  kind: StoryTopicKind;
  /** Typed text or a chip; ignored for 'lesson' / 'journal' / 'continue'. */
  text?: string;
  /** 'continue': the story to carry on from. */
  continueFrom?: StoryRecord;
}

/** Topic chips under "What should it be about?" (English: the prompt is English). */
export const STORY_TOPIC_CHIPS: ReadonlyArray<{ label: string; topic: string }> = [
  { label: '🍜 Food', topic: 'eating out in Taipei' },
  { label: '🏠 Family', topic: 'a family weekend' },
  { label: '🛍️ Shopping', topic: 'shopping at a night market' },
  { label: '🚇 Getting around', topic: 'taking the MRT' },
  { label: '☔ Weather', topic: 'a rainy day' },
  { label: '🎉 Weekend', topic: 'plans for the weekend' },
];

export interface StorySummary {
  chars: number;
  /** Share of content words that were rung 1 (known / due / learning) when it was written. */
  knownShare: number;
  newWords: Array<{ wordId?: string; text: string; glossEn: string; rung: VocabRung; inReview: boolean }>;
  tapped: string[];
}

interface Built {
  req: StoryRequest;
  key: string;
  ladder: VocabLadder;
  lessonId?: string;
  seriesId?: string;
  episode?: number;
  /** Phase 26: the ask's retry key (failures are counted per key). */
  askKey: string;
}

const startOfWeek = (now: Date): Date => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
};

/** Progress: characters read and stories finished this week (from Monday), without a service. */
export async function storyWeekStats(db: AnanDB, now: Date = new Date()): Promise<{ chars: number; finished: number }> {
  return storyReadingStats(await db.stories.toArray(), startOfWeek(now));
}

export class StoryService {
  private readonly inflight = new Map<string, Promise<StoryRecord>>();
  /** Phase 26 B3: failed attempts per ask, so the next try is a new variant (and a new topic). */
  private readonly failures = new Map<string, number>();
  /** Phase 26 Part E: background "ready ahead" pauses after failures in a row. */
  private readyFailures = 0;
  private readyPausedUntil = 0;

  constructor(
    private readonly db: AnanDB,
    private readonly lexicon: Lexicon,
    private readonly learnerService: LearnerService,
    private readonly llm: StoryLLM,
    private readonly env: StoryEnvironment,
    private readonly rng: () => number = Math.random,
  ) {}

  // ---- the ladder and the request --------------------------------------------------

  async ladderFor(level: Level, now: Date): Promise<{ ladder: VocabLadder; sets: WordSets }> {
    const sets = await this.learnerService.wordSets(now);
    const studyFocus = await this.env.studyFocus?.().catch(() => undefined);
    const ladder = vocabLadder({
      lexicon: this.lexicon,
      level,
      knownIds: sets.knownIds,
      dueIds: sets.dueIds,
      learningIds: sets.learningIds,
      books: this.env.books(),
      ...(studyFocus ? { studyFocus } : {}),
    });
    return { ladder, sets };
  }

  /** The lesson theme (the default topic), as the prompt and the page show it. */
  lessonTopic(ladder: VocabLadder): string {
    const a = ladder.lessons.active;
    return a ? `${a.titleEn}: ${a.topic}` : 'everyday life in Taipei';
  }

  /** Phase 26 B3: the lesson theme, then two more lesson-related topics, rotating on each failure. */
  lessonTopics(ladder: VocabLadder): string[] {
    const a = ladder.lessons.active;
    if (!a) return [this.lessonTopic(ladder)];
    const lesson = this.env
      .books()
      .flatMap((b) => b.lessons)
      .find((l) => l.id === a.lessonId);
    const more = (lesson?.objectives ?? []).filter(Boolean).slice(0, 2).map((o) => `${a.topic}: ${o}`);
    return [this.lessonTopic(ladder), ...more];
  }

  private askKey(ask: StoryAsk, lessonId?: string): string {
    return [ask.level, ask.difficulty, ask.kind, ask.text?.trim() ?? '', ask.continueFrom?.id ?? '', lessonId ?? ''].join('|');
  }

  private async topicFor(ask: StoryAsk, ladder: VocabLadder, failed = 0): Promise<string> {
    if (ask.kind === 'continue' && ask.continueFrom) return ask.continueFrom.topic;
    if ((ask.kind === 'typed' || ask.kind === 'chip') && ask.text?.trim()) return ask.text.trim().slice(0, 200);
    if (ask.kind === 'journal') {
      const last = await this.db.journalEntries.orderBy('createdAt').last();
      const first = last?.text.split(/[。！？\n]/)[0]?.trim();
      if (first) return `what I wrote in my journal: ${first}`.slice(0, 200);
    }
    const topics = this.lessonTopics(ladder);
    return topics[failed % topics.length]!;
  }

  async build(ask: StoryAsk, now: Date): Promise<Built> {
    const { ladder, sets } = await this.ladderFor(ask.level, now);
    const budget = storyBudget(ask.difficulty);
    const recent = [...sets.learningIds];
    const lessonId = ladder.lessons.active?.lessonId;
    const askKey = this.askKey(ask, lessonId);
    const failed = this.failures.get(askKey) ?? 0;
    const topic = await this.topicFor(ask, ladder, failed);
    const topicWords = (await this.env.topicWords?.(topic, ask.level).catch(() => [] as string[])) ?? [];
    const { rungs, groups } = storyPromptLists({
      ladder,
      lexicon: this.lexicon,
      dueIds: sets.dueIds,
      recentIds: recent,
      rng: this.rng,
      topic,
      topicWords,
    });
    const pattern = (id: string) => this.lexicon.grammarItemById(id)?.pattern;
    const prev = ask.kind === 'continue' ? ask.continueFrom : undefined;
    const names = [
      ...new Set([
        ...ladder.properNounIds.flatMap((id) => this.lexicon.byId(id)?.headword ?? []),
        ...(prev?.characters ?? []),
      ]),
    ].slice(0, 40);
    const req: StoryRequest = {
      topic,
      learnerLevel: ask.level,
      length: storyLength(ask.level),
      rungs,
      groups,
      budget: promptBudget(budget),
      grammar: ladder.grammar.allowed.flatMap((id) => pattern(id) ?? []).slice(0, 80),
      grammarNext: ladder.grammar.next.flatMap((id) => pattern(id) ?? []).slice(0, 20),
      names,
      ...(prev ? { previous: { title: prev.titleZh, summaryEn: prev.summaryEn } } : {}),
    };
    const seriesId = prev ? (prev.seriesId ?? prev.id) : undefined;
    const episode = prev ? (prev.episode ?? 1) + 1 : undefined;
    // Another story on the same topic for the same lesson is a new variant, and so is every try
    // after a failure (Phase 26 B3: a failed request is remembered; a retry never repeats it).
    const library = await this.db.stories.toArray();
    const saved = library.filter(
      (s) => s.topic === topic && s.lessonId === lessonId && s.difficulty === ask.difficulty && s.seriesId === seriesId,
    ).length;
    const variant = saved + failed;
    if (variant > 0) req.variant = variant;
    if (failed > 0) req.fresh = true;
    const key = storyRequestKey({ ...req, difficulty: ask.difficulty, ...(seriesId ? { seriesId } : {}), variant });
    return {
      req,
      key,
      askKey,
      ladder,
      ...(lessonId ? { lessonId } : {}),
      ...(seriesId ? { seriesId } : {}),
      ...(episode ? { episode } : {}),
    };
  }

  // ---- writing --------------------------------------------------------------------

  /** Writes (or returns, when the same request was already written) a story and saves it. */
  async write(ask: StoryAsk, now: Date = new Date(), onProgress?: (stage: StoryStage) => void): Promise<StoryRecord> {
    const built = await this.build(ask, now);
    const existing = await this.db.stories.get(built.key);
    if (existing) return existing; // never paid for twice
    const pending = this.inflight.get(built.key);
    if (pending) return pending;
    const run = this.generate(built, ask, now, onProgress).finally(() => this.inflight.delete(built.key));
    this.inflight.set(built.key, run);
    return run;
  }

  private async generate(built: Built, ask: StoryAsk, now: Date, onProgress?: (stage: StoryStage) => void): Promise<StoryRecord> {
    let out: Awaited<ReturnType<typeof runStoryPipeline>>;
    try {
      out = await runStoryPipeline({
        llm: this.llm,
        req: built.req,
        ladder: built.ladder,
        lexicon: this.lexicon,
        difficulty: ask.difficulty,
        ...(onProgress ? { onProgress } : {}),
      });
    } catch (err) {
      this.failures.set(built.askKey, (this.failures.get(built.askKey) ?? 0) + 1);
      throw err;
    }
    if (!out.ok) {
      this.failures.set(built.askKey, (this.failures.get(built.askKey) ?? 0) + 1);
      throw new StoryUnavailableError(out.reasons);
    }
    const record = storyRecord(
      out.story,
      out.report,
      out.questions,
      {
        id: built.key,
        level: ask.level,
        difficulty: ask.difficulty,
        topic: built.req.topic,
        lessonId: built.lessonId,
        seriesId: built.seriesId,
        episode: built.episode,
      },
      now,
    );
    await this.db.stories.put(record);
    return record;
  }

  // ---- the library ------------------------------------------------------------------

  /** Newest first. */
  async library(): Promise<StoryRecord[]> {
    const all = (await this.db.stories.orderBy('createdAt').reverse().toArray()) as StoryRecord[];
    return all.filter((s) => !s.report);
  }

  get(id: string): Promise<StoryRecord | undefined> {
    return this.db.stories.get(id);
  }

  /** Unread stories written for the lesson the learner is on now (oldest first). */
  async readyFor(level: Level, now: Date = new Date()): Promise<StoryRecord[]> {
    const { ladder } = await this.ladderFor(level, now);
    const lessonId = ladder.lessons.active?.lessonId;
    const all = await this.db.stories.toArray();
    return all
      .filter((s) => !s.readAt && !s.report && s.lessonId === lessonId && s.level === level)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * "Next story": a ready one when there is one, then an unread lesson story written ahead for the
   * current lesson (Phase 26 Part E, no model call), otherwise a new one on the lesson theme.
   */
  async next(level: Level, difficulty: StoryDifficulty, now: Date = new Date(), onProgress?: (stage: StoryStage) => void): Promise<StoryRecord> {
    const ready = (await this.readyFor(level, now)).find((s) => s.difficulty === difficulty);
    if (ready) return ready;
    const lesson = await this.nextLessonStory(level, now);
    if (lesson) return lesson;
    return this.write({ level, difficulty, kind: 'lesson' }, now, onProgress);
  }

  /** Phase 26 Part E: the next unread lesson story for the current lesson, put in the library. */
  async nextLessonStory(level: Level, now: Date = new Date()): Promise<StoryRecord | undefined> {
    if (!this.env.lessonStories) return undefined;
    const { ladder } = await this.ladderFor(level, now);
    const active = ladder.lessons.active;
    if (!active) return undefined;
    const pool = await this.env.lessonStories(active.bookId).catch(() => [] as LessonStory[]);
    const library = new Map((await this.db.stories.toArray()).map((s) => [s.id, s]));
    for (const ls of pool.filter((x) => x.lessonId === active.lessonId)) {
      const id = `lesson-${ls.id}`;
      const have = library.get(id);
      if (have) {
        if (!have.readAt && !have.report) return have;
        continue;
      }
      const res = ls.story;
      const names = ladder.properNounIds.flatMap((x) => this.lexicon.byId(x)?.headword ?? []);
      const report = analyzeStory(
        res.paragraphs.map((p) => p.zh),
        { ladder, lexicon: this.lexicon, allowedTexts: storyAllowedNames(names, res.characters, this.lexicon), glossed: new Set(res.glosses.map((g) => g.zh)) },
        storyBudget('middle'),
      );
      const record = storyRecord(res, report, res.questions, { id, level, difficulty: 'middle', topic: ls.topic, lessonId: ls.lessonId }, now);
      await this.db.stories.put(record);
      return record;
    }
    return undefined;
  }

  /** Keeps `readyAhead` unread stories for the current lesson, in the background. Failures are quiet. */
  async ensureReady(
    level: Level,
    difficulty: StoryDifficulty,
    now: Date = new Date(),
    /** Phase 25: checked before each story (one at a time); false pauses (e.g. while chatting). */
    keepGoing: () => boolean = () => true,
  ): Promise<number> {
    let ready = (await this.readyFor(level, now)).filter((s) => s.difficulty === difficulty).length;
    const pause = STORY_CONFIG.readyAheadPause;
    while (ready < STORY_CONFIG.readyAhead && keepGoing() && now.getTime() >= this.readyPausedUntil) {
      try {
        await this.write({ level, difficulty, kind: 'lesson' }, now);
        this.readyFailures = 0;
      } catch {
        // Phase 26: after 2 failures in a row, no background story for an hour (free quota).
        if (++this.readyFailures >= pause.failures) this.readyPausedUntil = now.getTime() + pause.pauseMs;
        break;
      }
      ready++;
    }
    return ready;
  }

  /** "You'll find this one easier now". */
  async rereads(now: Date = new Date()): Promise<StoryRecord[]> {
    const { knownIds } = await this.learnerService.wordSets(now);
    return rereadSuggestions((await this.db.stories.toArray()).filter((s) => !s.report), knownIds, now);
  }

  /** Progress: characters read and stories finished this week (from Monday). */
  async weekStats(now: Date = new Date()): Promise<{ chars: number; finished: number }> {
    return storyWeekStats(this.db, now);
  }

  // ---- reading ----------------------------------------------------------------------

  /** A tap (gloss) or reading reveal on a word: a lookup, as in the reader. */
  async recordLookup(wordId: string, kind: 'chat_lookup_gloss' | 'chat_hover_reading', storyId: string, now: Date = new Date()): Promise<void> {
    await this.learnerService.record(
      { item: { kind: 'word', id: wordId }, skill: 'recognition', kind, at: now, context: { source: 'story', refId: storyId } },
      now,
    );
  }

  /**
   * Finishing: every due or learning word read without a lookup gives `story_read_no_lookup` (weak,
   * like chat). Correct answers give no word evidence, only the story's score.
   */
  async finish(
    story: StoryRecord,
    result: { lookedUp: ReadonlySet<string>; right: number; of: number },
    now: Date = new Date(),
  ): Promise<{ evidence: number; story: StoryRecord }> {
    const { dueIds, learningIds } = await this.learnerService.wordSets(now);
    const events: Evidence[] = story.wordIds
      .filter((id) => !result.lookedUp.has(id) && (dueIds.has(id) || learningIds.has(id)))
      .map((id) => ({
        item: { kind: 'word' as const, id },
        skill: 'recognition' as const,
        kind: 'story_read_no_lookup' as const,
        at: now,
        context: { source: 'story' as const, refId: story.id },
      }));
    if (events.length > 0) await this.learnerService.recordBulk(events, now);
    const updated: StoryRecord = {
      ...story,
      readAt: now,
      updatedAt: now,
      score: { right: result.right, of: result.of },
      readCount: (story.readCount ?? 0) + 1,
      readDates: [...(story.readDates ?? []), now],
    };
    await this.db.stories.put(updated);
    return { evidence: events.length, story: updated };
  }

  /** The after-reading summary. */
  async summary(story: StoryRecord, lookedUp: ReadonlySet<string>, now: Date = new Date()): Promise<StorySummary> {
    const cards = await this.learnerService.allCards();
    const carded = new Set(cards.filter((c) => c.item.kind === 'word').map((c) => c.item.id));
    void now;
    return {
      chars: story.chars,
      knownShare: story.rung1Share,
      newWords: story.newWords.map((w) => {
        const word = w.wordId ? this.lexicon.byId(w.wordId) : undefined;
        const gloss = story.glosses.find((g) => g.zh === w.text)?.en;
        return {
          ...(w.wordId ? { wordId: w.wordId } : {}),
          text: w.text,
          glossEn: word ? glossFor(word, { textbook: false }) : (gloss ?? ''),
          rung: w.rung,
          inReview: !!w.wordId && carded.has(w.wordId),
        };
      }),
      tapped: [...lookedUp].flatMap((id) => this.lexicon.byId(id)?.headword ?? []),
    };
  }

  /** "Something's wrong": the story leaves the library (synced); `undo` puts it back. */
  async report(story: StoryRecord, reason: string, note: string, now: Date = new Date()): Promise<() => Promise<void>> {
    await this.db.stories.put({ ...story, updatedAt: now, report: { reason, ...(note ? { note } : {}), at: now } });
    return async () => {
      const cur = await this.db.stories.get(story.id);
      if (!cur) return;
      const { report: _r, ...rest } = cur;
      await this.db.stories.put({ ...rest, updatedAt: new Date(Math.max(Date.now(), now.getTime() + 1)) });
    };
  }

  /** "Add to review": New cards, which enter sessions within the daily new-word allowance (Phase 20). */
  async addToReview(wordIds: readonly string[], now: Date = new Date()): Promise<void> {
    for (const id of wordIds) await this.learnerService.restore({ kind: 'word', id }, now);
  }
}
