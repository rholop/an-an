import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildReorderExercise,
  classLevelHint,
  courseBook,
  courseLessonLevel,
  glossFor,
  courseOrdinal,
  isPractisedListening,
  isStrongListening,
  LAIXUE_COURSE,
  lessonDone,
  lessonProgress,
  requeueAgain,
  type GrammarItem,
  type Lesson,
  type LessonProgress,
  type Lexicon,
  type SentenceBankEntry,
  type SkillCard,
  type Textbook,
  newSessionSeed,
  sessionMeta,
} from '@anan/core';
import { AnnotatedInline, AnnotatedWord, useReadingScript } from '../components/AnnotatedInline.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { db, learnerService } from '../db/instance.js';
import { loadReviewStatus } from '../lib/review-status.js';
import { setMyClass, useMyClass } from '../lib/my-class.js';
import { buildGrammarExercises, describeGrammarExercise, type GrammarExercise } from '../lib/textbook-session.js';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import { lessonSessionCards, newSessionCard } from '../lib/review-session.js';
import { excludedZh } from '../lib/cloze-reports.js';
import {
  bookSubtitle,
  bookTitle,
  CURRENT_LESSON,
  FEEDBACK_CORRECT,
  feedbackWrong,
  lessonLabel,
  lessonOnly,
  lessonsMasteredLine,
  levelLabel,
  listeningLine,
  NEXT,
  STUDY_THIS_LESSON,
  TERM,
  UNDO,
  yourClassLabel,
} from '../lib/labels.js';
import { LearnedMastered } from '../components/LearnedMastered.js';
import {
  getStudyBooks,
  getStudyFocusNow,
  lessonIndexFor,
  useClassScope,
  useProgressData,
  useStudyFocus,
  useStudySettings,
} from '../lib/study.js';
import {
  fetchPrivateTextbook,
  useTextbook,
  useTextbookSentences,
  type BookData,
  type PrivateDialogue,
  type PrivateExample,
  type PrivateResult,
} from '../lib/textbook-data.js';
import { useLexicon } from '../lib/useLexicon.js';
import { QuickKnownCheck } from '../components/QuickKnownCheck.js';
import { ChatPage } from './ChatPage.js';
import { ListenPage } from './ListenPage.js';
import { useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { allListeningCards } from '../db/queries.js';
import { JournalPage } from './JournalPage.js';
import { ReviewPage } from './ReviewPage.js';
import './TextbookPage.css';

type View =
  | { kind: 'path' }
  | { kind: 'lesson'; bookId: string; n: number }
  | { kind: 'study'; bookId: string; n: number };

export function TextbookPage() {
  const lexiconState = useLexicon();
  const textbook = useTextbook();
  const myClass = useMyClass();
  const sentencesState = useTextbookSentences();
  const script = useReadingScript();
  const [view, setView] = useState<View>({ kind: 'path' });
  const [tick, setTick] = useState(0);
  // Phase 21: the same numbers as Home (one ProgressIndex, refreshed after every change).
  const progressData = useProgressData();
  const studySettings = useStudySettings();
  const { focus } = useStudyFocus();
  const scope = useClassScope();
  const [extras, setExtras] = useState<{ scenarios: Set<string>; prompts: Set<string> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [convs, entries] = await Promise.all([
        db.conversations.toArray(),
        db.journalEntries.where('status').equals('finished').toArray(),
      ]);
      if (cancelled) return;
      setExtras({
        scenarios: new Set(convs.filter((c) => c.completed).map((c) => c.scenarioId)),
        prompts: new Set(entries.flatMap((e) => (e.promptId ? [e.promptId] : []))),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [tick, view.kind, progressData]);
  const progress = useMemo(() => {
    const out = new Map<string, LessonProgress>();
    if (textbook.status !== 'ready' || !progressData) return out;
    for (const b of textbook.books)
      for (const l of b.lessons)
        out.set(
          l.id,
          lessonProgress(l, {
            index: progressData.index,
            completedScenarioIds: extras?.scenarios ?? new Set(),
            donePromptIds: extras?.prompts ?? new Set(),
          }),
        );
    return out;
  }, [textbook, progressData, extras]);
  const isDone = (p: LessonProgress | undefined) => !!p && lessonDone(p, studySettings.masteryShare);

  if (lexiconState.status === 'loading' || textbook.status === 'loading') return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (textbook.status === 'missing') {
    return (
      <div className="textbook-page">
        <h1 lang="zh-Hant">來學華語</h1>
        <p>
          The textbook data isn&apos;t built yet. Run <code>pnpm curriculum:build</code> and{' '}
          <code>pnpm --filter @anan/web sync:textbook</code>.
        </p>
      </div>
    );
  }

  const { books, data: allData } = textbook;
  const lexicon = lexiconState.lexicon;
  const sentences = sentencesState.status === 'ready' ? sentencesState.sentences : [];
  if (view.kind === 'study') {
    const book = books.find((b) => b.id === view.bookId)!;
    const lesson = book.lessons.find((l) => l.n === view.n)!;
    return (
      <StudySession
        lesson={lesson}
        bookId={view.bookId}
        data={allData.find((d) => d.textbook.id === view.bookId)!}
        lexicon={lexicon}
        sentences={sentences.filter((s) => (s.textbookId ?? 'laixue-1') === view.bookId)}
        onExit={() => {
          setTick((t) => t + 1);
          setView({ kind: 'lesson', bookId: view.bookId, n: view.n });
        }}
      />
    );
  }

  if (view.kind === 'lesson') {
    const book = books.find((b) => b.id === view.bookId)!;
    const lesson = book.lessons.find((l) => l.n === view.n)!;
    return (
      <LessonDetail
        lesson={lesson}
        bookId={view.bookId}
        data={allData.find((d) => d.textbook.id === view.bookId)!}
        lexicon={lexicon}
        sentences={sentences.filter((s) => (s.textbookId ?? 'laixue-1') === view.bookId)}
        script={script}
        progress={progress.get(lesson.id)}
        onBack={() => setView({ kind: 'path' })}
        onStudy={() => setView({ kind: 'study', bookId: view.bookId, n: view.n })}
      />
    );
  }

  const jump = (id: string) =>
    document.getElementById(`textbook-book-${id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });

  return (
    <div className="textbook-page">
      <h1>
        <span lang="zh-Hant">{LAIXUE_COURSE.titleZh}</span>{' '}
        <small>{LAIXUE_COURSE.titleEn}</small>
      </h1>
      <MyClassPanel books={books} />
      {myClass.enabled && (
        <p className="textbook-here" data-testid="class-status">
          {yourClassLabel(myClass.currentLesson, myClass.textbookId)}
          {focus?.activeLesson && focus.activeLesson.lessonId !== focus.classLesson?.lessonId && (
            <span className="textbook-muted">
              {' '}
              · {CURRENT_LESSON}: {lessonLabel(focus.activeLesson.n, focus.activeLesson.bookId)}
            </span>
          )}
        </p>
      )}
      {books.length > 1 && (
        <nav className="textbook-books" aria-label="Books" data-testid="book-picker">
          {books.map((b) => {
            const cb = courseBook(LAIXUE_COURSE, b.id);
            return (
              <button key={b.id} type="button" onClick={() => jump(b.id)} data-testid={`book-${b.id}`}>
                <span lang="zh-Hant">{bookTitle(b.id)}</span>
                {cb && <small> · {cb.levelLabel}</small>}
              </button>
            );
          })}
        </nav>
      )}
      {books.map((book) => {
        const cb = courseBook(LAIXUE_COURSE, book.id);
        const done = book.lessons.filter((l) => isDone(progress.get(l.id))).length;
        return (
          <section key={book.id} id={`textbook-book-${book.id}`} className="textbook-book" aria-label={bookSubtitle(book.id)}>
            <h2>
              <span lang="zh-Hant">{bookTitle(book.id)}</span> <small>{bookSubtitle(book.id)}</small>
            </h2>
            <p className="textbook-muted" data-testid={`book-progress-${book.id}`}>
              {cb ? `${cb.levelLabel} · ` : ''}
              {lessonsMasteredLine(done, book.lessons.length)}
            </p>
            <ol className="textbook-path">
              {book.lessons.map((l) => {
                const p = progress.get(l.id);
                const ord = courseOrdinal(LAIXUE_COURSE, book.id, l.n) ?? 0;
                // Visibility follows the class scope (one "Lessons ahead of class" setting).
                const state = !scope.enabled
                  ? 'idle'
                  : ord < scope.courseOrdinal
                    ? 'past'
                    : ord === scope.courseOrdinal
                      ? 'now'
                      : ord <= scope.courseOrdinal + scope.aheadLessons
                        ? 'next'
                        : 'later';
                const isCurrent = focus?.activeLesson?.lessonId === l.id;
                return (
                  <li
                    key={l.id}
                    className={`textbook-lesson textbook-lesson--${state}`}
                    data-testid={book.id === 'laixue-1' ? `lesson-${l.n}` : `lesson-${book.id}-${l.n}`}
                  >
                    <button
                      className="textbook-lesson-btn"
                      onClick={() => setView({ kind: 'lesson', bookId: book.id, n: l.n })}
                    >
                      <span className="textbook-lesson-n">{l.n}</span>
                      <span className="textbook-lesson-title">
                        <span lang="zh-Hant">{l.titleZh}</span>
                        <small>
                          {l.titleEn} · {l.topic}
                        </small>
                      </span>
                      {isCurrent && (
                        <span className="textbook-chip" data-testid="current-lesson-chip">{CURRENT_LESSON}</span>
                      )}
                      {state === 'now' && <span className="textbook-chip textbook-chip--soft">Your class</span>}
                      {state === 'next' && (
                        <span className="textbook-chip textbook-chip--soft">ahead</span>
                      )}
                      {isDone(p) && (
                        <span className="textbook-chip textbook-chip--good">{TERM.mastered}</span>
                      )}
                    </button>
                    {p && <ProgressRow p={p} />}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** Phase 21 Part C: the same "Learned · Mastered" numbers as Home, over the same lesson items. */
function ProgressRow({ p }: { p: LessonProgress }) {
  return (
    <div className="textbook-progress" aria-label="Lesson progress" data-testid="lesson-progress">
      <LearnedMastered p={p} compact />
      <span>
        Grammar {p.grammarMastered}/{p.grammarTotal} {TERM.mastered.toLowerCase()} · Scenarios {p.scenariosDone}/
        {p.scenariosTotal} · Journal {p.promptsDone}/{p.promptsTotal}
      </span>
    </div>
  );
}

/** Settings: "My class" on/off and the class position (book + lesson). Synced with the profile. */
function MyClassPanel({ books }: { books: Textbook[] }) {
  const myClass = useMyClass();
  const [note, setNote] = useState<string | null>(null);
  const book = books.find((b) => b.id === myClass.textbookId) ?? books[0]!;

  async function apply(patch: { enabled?: boolean; textbookId?: string; currentLesson?: number }) {
    const next = { ...myClass, ...patch };
    // Phase 21: lessons the TOCFL gate holds back are listed but not introduced into review yet.
    const focus = await getStudyFocusNow().catch(() => undefined);
    const { added } = await setMyClass(patch, {
      books,
      recorder: learnerService,
      gatedLessonIds: new Set(focus?.gatedLessonIds ?? []),
    });
    setNote(
      next.enabled && added > 0
        ? `Added ${added} words and grammar points from the lessons up to ${lessonLabel(next.currentLesson, next.textbookId)} to your reviews.`
        : null,
    );
  }

  return (
    <section className="textbook-class" aria-label="My class">
      <label>
        <input
          type="checkbox"
          checked={myClass.enabled}
          onChange={(e) => void apply({ enabled: e.target.checked })}
          data-testid="my-class-toggle"
        />{' '}
        My class — I&apos;m studying this textbook
      </label>
      {books.length > 1 && (
        <label>
          Book:{' '}
          <select
            value={book.id}
            onChange={(e) => void apply({ textbookId: e.target.value, currentLesson: 1 })}
            data-testid="my-class-book"
          >
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {bookTitle(b.id)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Your class is on:{' '}
        <select
          value={myClass.currentLesson}
          onChange={(e) => void apply({ currentLesson: Number(e.target.value) })}
          data-testid="my-class-lesson"
        >
          {book.lessons.map((l) => (
            <option key={l.id} value={l.n}>
              {lessonOnly(l.n)}. {l.titleEn}
            </option>
          ))}
        </select>
      </label>
      {myClass.enabled && (
        <p className="textbook-muted" data-testid="class-level-hint-textbook">
          {classLevelHint(book.id, myClass.currentLesson)}. Your level picker is not changed for you
          — {levelLabel(courseLessonLevel(LAIXUE_COURSE, book.id, myClass.currentLesson))} would
          match this lesson.
        </p>
      )}
      <p className="textbook-muted">
        Words and grammar from every earlier lesson of the course (all earlier books too) and up to
        the current one join your reviews (never marked known by themselves). Going back a lesson
        deletes nothing. Turn this off and the app behaves exactly as it did before.
      </p>
      {note && <p role="status">{note}</p>}
    </section>
  );
}

function LessonDetail({
  lesson,
  bookId,
  data,
  lexicon,
  sentences,
  script,
  progress,
  onBack,
  onStudy,
}: {
  lesson: Lesson;
  bookId: string;
  data: BookData;
  lexicon: Lexicon;
  sentences: SentenceBankEntry[];
  script: AnnotationScript;
  progress: LessonProgress | undefined;
  onBack: () => void;
  onStudy: () => void;
}) {
  const [checking, setChecking] = useState(false);
  // Phase 15: listening stats show separately (they never count toward mastery).
  // Phase 21: practised = answered at least once (auto-created cards don't count); strong from the shared config.
  const [listenStats, setListenStats] = useState<{ practised: number; strong: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    allListeningCards(db).then((cards) => {
      if (cancelled) return;
      const mine = new Set(lesson.vocab.filter((id) => !lesson.properNouns.includes(id)));
      const own = cards.filter((c) => mine.has(c.item.id));
      setListenStats({ practised: own.filter((c) => isPractisedListening(c)).length, strong: own.filter((c) => isStrongListening(c)).length });
    });
    return () => {
      cancelled = true;
    };
  }, [lesson]);
  const grammar = lesson.grammar
    .map((id) => data.grammarItems.find((g) => g.id === id))
    .filter((g): g is GrammarItem => Boolean(g));
  const words = [...new Set(lesson.vocab)].flatMap((id) => lexicon.byId(id) ?? []);
  const supp = [...new Set(lesson.supplementary)].flatMap((id) => lexicon.byId(id) ?? []);
  const exampleFor = (g: GrammarItem) =>
    g.examples.flatMap((id) => sentences.find((s) => s.id === id) ?? []).slice(0, 3);

  return (
    <div className="textbook-page">
      <button onClick={onBack}>← All lessons</button>
      <h1>
        <span className="textbook-badge" lang="zh-Hant">
          {lessonLabel(lesson.n, bookId)}
        </span>{' '}
        <span lang="zh-Hant">{lesson.titleZh}</span> <small>{lesson.titleEn}</small>
      </h1>
      <p className="textbook-muted">Topic: {lesson.topic}</p>
      {listenStats && listenStats.practised > 0 && (
        <p className="textbook-muted" data-testid="listening-stats">
          {listeningLine(listenStats.practised, listenStats.strong)} (not part of mastery)
        </p>
      )}
      {progress && <ProgressRow p={progress} />}
      <button className="textbook-study-btn btn-primary" onClick={onStudy} data-testid="study-lesson">
        {STUDY_THIS_LESSON}
      </button>{' '}
      <button onClick={() => setChecking((c) => !c)} data-testid="mark-known">
        I already know this lesson
      </button>
      {checking && (
        <QuickKnownCheck
          lesson={lesson}
          lexicon={lexicon}
          grammar={data.grammarItems}
          sentences={sentences}
          onClose={() => setChecking(false)}
        />
      )}

      <h2>By the end you can…</h2>
      <ul>
        {lesson.objectives.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>

      <h2>Words ({words.length})</h2>
      <ul className="textbook-words">
        {words.map((w) => (
          <li key={w.id}>
            <span lang="zh-Hant">
              <AnnotatedWord word={w} script={script} textbook />
            </span>{' '}
            <span className="textbook-muted">{glossFor(w, { textbook: true })}</span>
            {lesson.properNouns.includes(w.id) && (
              <span className="textbook-muted" data-testid="proper-noun-note"> · name, not counted</span>
            )}
          </li>
        ))}
      </ul>
      {supp.length > 0 && (
        <>
          <h3>Supplementary words</h3>
          <ul className="textbook-words">
            {supp.map((w) => (
              <li key={w.id}>
                <span lang="zh-Hant">
                  <AnnotatedWord word={w} script={script} textbook />
                </span>{' '}
                <span className="textbook-muted">{glossFor(w, { textbook: true })}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Grammar ({grammar.length})</h2>
      {grammar.map((g) => (
        <article key={g.id} className="textbook-grammar">
          <h3 lang="zh-Hant">{g.pattern}</h3>
          <p>{g.explanationEn}</p>
          {exampleFor(g).map((s) => (
            <p key={s.id} className="textbook-example">
              <span lang="zh-Hant">
                <AnnotatedInline text={s.zh} lexicon={lexicon} script={script} textbook />
              </span>
              <br />
              <small className="textbook-muted">{s.en}</small>
            </p>
          ))}
        </article>
      ))}

      <h2>Dialogue</h2>
      <Dialogue lesson={lesson} bookId={bookId} lexicon={lexicon} script={script} />
    </div>
  );
}

/** The book's own dialogue: private, fetched through the proxy behind the household code. */
function Dialogue({
  lesson,
  bookId,
  lexicon,
  script,
}: {
  lesson: Lesson;
  bookId: string;
  lexicon: Lexicon;
  script: AnnotationScript;
}) {
  const [res, setRes] = useState<PrivateResult<Record<string, PrivateDialogue>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchPrivateTextbook<Record<string, PrivateDialogue>>('dialogues', bookId).then((r) => {
      if (!cancelled) setRes(r);
    });
    return () => {
      cancelled = true;
    };
  }, [bookId]);
  if (!res) return <p className="textbook-muted">Loading…</p>;
  if (res.status !== 'ok') {
    return (
      <p className="textbook-muted" data-testid="dialogue-unavailable">
        {res.status === 'locked'
          ? 'Enter the household code to read the dialogue.'
          : res.status === 'missing'
            ? 'The dialogue text isn’t installed on this server (it is not part of the app’s public files).'
            : 'The dialogue couldn’t be loaded right now.'}
      </p>
    );
  }
  const lines = res.data[lesson.id]?.lines ?? [];
  return (
    <div className="textbook-dialogue" data-testid="dialogue">
      {lines.map((l, i) => (
        <p key={i}>
          <strong lang="zh-Hant">{l.speaker}：</strong>
          <span lang="zh-Hant">
            <AnnotatedInline text={l.zh} lexicon={lexicon} script={script} textbook />
          </span>{' '}
          {/* Phase 21: the one speaker rule (shown only when a verified clip exists; never autoplays). */}
          <SpeakerButton kind="sentence" text={l.zh} />
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Study this lesson: vocab → grammar cloze/reorder → scenario → journal.
// ---------------------------------------------------------------------------

type Step = 'vocab' | 'grammar' | 'listening' | 'scenario' | 'journal';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'vocab', label: 'Vocabulary review' },
  { id: 'grammar', label: 'Grammar practice' },
  { id: 'listening', label: 'Listening round' },
  { id: 'scenario', label: 'Chat scenario' },
  { id: 'journal', label: 'Journal prompt' },
];

function StudySession({
  lesson,
  bookId,
  data,
  lexicon,
  sentences,
  onExit,
}: {
  lesson: Lesson;
  bookId: string;
  data: BookData;
  lexicon: Lexicon;
  sentences: SentenceBankEntry[];
  onExit: () => void;
}) {
  const clips = useListeningClips();
  const listeningOn = useListeningEnabled();
  // Steps with nothing to do are dropped; the rest can each be skipped.
  const steps = useMemo(
    () =>
      STEPS.filter((s) =>
        s.id === 'listening'
          ? listeningOn && clips.ready && lesson.vocab.some((id) => clips.hasClip('word', id))
          : s.id === 'scenario'
          ? lesson.scenarios.length > 0
          : s.id === 'journal'
            ? lesson.journalPrompts.length > 0
            : true,
      ),
    [lesson, listeningOn, clips],
  );
  const [i, setI] = useState(0);
  const step = steps[i];
  const next = useCallback(
    () => (i + 1 >= steps.length ? onExit() : setI(i + 1)),
    [i, steps.length, onExit],
  );

  if (!step) return null;
  return (
    <div className="textbook-study" data-testid="study-session">
      <div className="textbook-study-bar">
        <strong>
          <span lang="zh-Hant">{lessonLabel(lesson.n, bookId)}</span> · Step {i + 1} of {steps.length}:{' '}
          {step.label}
        </strong>
        <span>
          <button onClick={next} data-testid="study-skip">
            {i + 1 >= steps.length ? 'Finish' : 'Skip step →'}
          </button>{' '}
          <button onClick={onExit}>Exit</button>
        </span>
      </div>
      {step.id === 'vocab' && <VocabStep lesson={lesson} bookId={bookId} onDone={next} />}
      {step.id === 'grammar' && (
        <GrammarStep
          lesson={lesson}
          bookId={bookId}
          data={data}
          lexicon={lexicon}
          sentences={sentences}
          onDone={next}
        />
      )}
      {step.id === 'listening' && (
        <ListenPage
          key={`listen-${lesson.id}`}
          title={`${lessonLabel(lesson.n, bookId)} — listening`}
          size={6}
          onlyWordIds={new Set(lesson.vocab.filter((id) => !lesson.properNouns.includes(id)))}
          onExit={next}
          exitLabel={NEXT}
        />
      )}
      {step.id === 'scenario' && (
        <ChatPage key={lesson.scenarios[0]} initialScenarioId={lesson.scenarios[0]} onExit={next} />
      )}
      {step.id === 'journal' && (
        <JournalPage
          key={lesson.id}
          lesson={lesson.n}
          bookId={bookId}
          initialPromptId={(lesson.journalPrompts[0] ?? {}).id}
          onDone={next}
        />
      )}
    </div>
  );
}

/**
 * Phase 21 Part D: a real session for the lesson: its Due cards (recognition and production), then
 * its New items under the Phase 20 allowance. Never "Nothing due" while the lesson has words to go.
 */
function VocabStep({ lesson, bookId, onDone }: { lesson: Lesson; bookId: string; onDone: () => void }) {
  const [plan, setPlan] = useState<{ due: SkillCard[]; fresh: SkillCard[]; paused?: string; left: number } | null>(null);
  const progressData = useProgressData();
  useEffect(() => {
    if (!progressData) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const [due, newCards, { status }, focus] = await Promise.all([
        learnerService.dueCards(now),
        learnerService.newCards(),
        loadReviewStatus(now),
        getStudyFocusNow(now).catch(() => undefined),
      ]);
      // Phase 22: the same new-word rule and message as Home and Review.
      const allowance = { allowed: status.newAllowed, reason: status.newMessage };
      const picked = lessonSessionCards({
        due,
        newCards,
        lesson,
        ...(focus ? { focus } : {}),
        lessonIdx: lessonIndexFor(getStudyBooks()),
        hasCard: (i) => progressData.index.hasCard(i),
        allowedNew: allowance.allowed,
      });
      const left = progressData.index.summarize(
        lesson.vocab.filter((id) => !lesson.properNouns.includes(id)).map((id) => ({ kind: 'word' as const, id })),
      );
      if (cancelled) return;
      setPlan({
        due: picked.due,
        fresh: [...picked.fresh, ...picked.newItems.map((i) => newSessionCard(i, now))],
        ...(allowance.reason ? { paused: allowance.reason } : {}),
        left: left.total - left.mastered,
      });
    })();
    return () => {
      cancelled = true;
    };
    // built once per lesson (later changes must not rebuild the running session)
  }, [lesson, !!progressData]);
  if (!plan) return <p>Loading…</p>;
  if (plan.due.length + plan.fresh.length === 0)
    return (
      <p data-testid="lesson-vocab-empty">
        {plan.left > 0
          ? `Nothing from this lesson to review right now: ${plan.left} word${plan.left === 1 ? '' : 's'} still to master come back as they fall due.${plan.paused ? ` ${plan.paused}` : ''}`
          : 'Every word of this lesson is mastered.'}{' '}
        <button onClick={onDone}>{NEXT}</button>
      </p>
    );
  return (
    <ReviewPage
      focusCards={plan.due}
      freshCards={plan.fresh}
      onExit={onDone}
      exitLabel="Done with vocabulary →"
      title={`${lessonLabel(lesson.n, bookId)} vocabulary`}
    />
  );
}

function GrammarStep({
  lesson,
  bookId,
  data,
  lexicon,
  sentences,
  onDone,
}: {
  lesson: Lesson;
  bookId: string;
  data: BookData;
  lexicon: Lexicon;
  sentences: SentenceBankEntry[];
  onDone: () => void;
}) {
  const script = useReadingScript();
  // Phase 19: the gap runs on from the vocabulary step (rule 7) via the recently shown cards.
  // Phase 21: reported sentences never come back here either; a miss comes back once at the end.
  const [exercises, setExercises] = useState<GrammarExercise[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void excludedZh(db).then((excluded) => {
      if (cancelled) return;
      const seed = newSessionSeed('grammar');
      const ex = buildGrammarExercises(lesson, data.grammarItems, sentences, {
        bookId,
        seed,
        recent: recentShown(),
        excluded,
      });
      logSessionOrder('lesson-grammar', seed, ex.length, sessionMeta(ex)?.deferred.length ?? 0);
      setExercises(ex);
    });
    return () => {
      cancelled = true;
    };
    // built once per lesson
  }, [lesson.id, bookId]);
  const [privateEx, setPrivateEx] = useState<PrivateExample[]>([]);
  // Exercises already sent round again (a miss comes back once, not forever).
  const requeued = useRef(new Set<GrammarExercise>());
  const [idx, setIdx] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [tally, setTally] = useState({ right: 0, wrong: 0 });
  const [history, setHistory] = useState<
    Array<{ idx: number; exercises: GrammarExercise[]; tally: { right: number; wrong: number }; undo: () => Promise<void> }>
  >([]);

  // The book's own worked examples (private) add extra "put the words in order" items when available.
  useEffect(() => {
    fetchPrivateTextbook<Record<string, PrivateExample[]>>('examples', bookId).then((r) => {
      if (r.status === 'ok')
        setPrivateEx((r.data[lesson.id] ?? []).filter((e) => !/[A-Za-z]/.test(e.zh)).slice(0, 3));
    });
  }, [lesson.id, bookId]);

  if (exercises === null) return <p>Loading…</p>;
  const total = exercises.length;
  const current = exercises[idx];
  const grammarName = (id: string) => data.grammarItems.find((g) => g.id === id)?.pattern ?? id;

  async function record(grammarId: string, correct: boolean) {
    if (!exercises) return;
    const now = new Date();
    if (current) noteShown(describeGrammarExercise(current).keys, now);
    const { undo } = await learnerService.recordUndoable(
      {
        item: { kind: 'grammar', id: grammarId },
        skill: 'recognition',
        kind: correct ? 'cloze_correct_nohint' : 'cloze_wrong',
        at: now,
        context: { source: 'textbook', refId: lesson.id },
      },
      now,
    );
    setHistory((h) => [...h, { idx, exercises, tally, undo }]);
    // Again: a miss comes back once at the end of the step.
    // The shared Again rule (Phase 19 gap kept); at the very end it simply goes last.
    if (!correct && current && !requeued.current.has(current)) {
      requeued.current.add(current);
      const q = requeueAgain(exercises, idx, describeGrammarExercise);
      setExercises(q.length > exercises.length ? q : [...exercises, current]);
    }
    setTally((t) => ({ right: t.right + (correct ? 1 : 0), wrong: t.wrong + (correct ? 0 : 1) }));
  }

  async function undoLast() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    await last.undo();
    setExercises(last.exercises);
    setTally(last.tally);
    setIdx(last.idx);
    setAttempt((a) => a + 1);
  }

  if (total === 0)
    return (
      <p>
        No practice sentences for this lesson yet. <button onClick={onDone}>{NEXT}</button>
      </p>
    );
  if (!current)
    return (
      <div className="textbook-grammar-done" role="status">
        <p>
          Grammar practice done: {tally.right} right, {tally.wrong} to revisit.
        </p>
        {privateEx.length > 0 && (
          <details>
            <summary>The book&apos;s own examples for this lesson</summary>
            {privateEx.map((e) => (
              <p key={e.zh} lang="zh-Hant">
                <AnnotatedInline text={e.zh} lexicon={lexicon} script={script} textbook />
              </p>
            ))}
          </details>
        )}
        <button onClick={onDone} data-testid="grammar-done">
          {NEXT}
        </button>
      </div>
    );

  return (
    <div className="textbook-exercise" data-testid="grammar-exercise">
      <p className="textbook-muted">
        {idx + 1} of {total} · <span lang="zh-Hant">{grammarName(current.grammarId)}</span>{' '}
        {history.length > 0 && (
          <button type="button" className="link-button" data-testid="grammar-undo" onClick={() => void undoLast()}>
            {UNDO}
          </button>
        )}
      </p>
      {current.type === 'cloze' ? (
        <ClozeView
          key={`${idx}:${attempt}`}
          lexicon={lexicon}
          script={script}
          ex={current}
          onAnswer={(ok) => void record(current.grammarId, ok)}
          onNext={() => setIdx(idx + 1)}
        />
      ) : (
        <ReorderView
          key={`${idx}:${attempt}`}
          zh={current.zh}
          en={current.en}
          lexicon={lexicon}
          script={script}
          onAnswer={(ok) => void record(current.grammarId, ok)}
          onNext={() => setIdx(idx + 1)}
        />
      )}
    </div>
  );
}

function ClozeView({
  ex,
  onAnswer,
  onNext,
  lexicon,
  script,
}: {
  ex: Extract<GrammarExercise, { type: 'cloze' }>;
  onAnswer: (ok: boolean) => void;
  onNext: () => void;
  lexicon: Lexicon;
  script: AnnotationScript;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      <p className="textbook-cloze" lang="zh-Hant">
        {ex.before}
        <span className="textbook-blank">{picked ?? '＿＿'}</span>
        {ex.after}
      </p>
      {ex.en && <p className="textbook-muted">{ex.en}</p>}
      <div className="textbook-options">
        {ex.options.map((o) => (
          <button
            key={o}
            lang="zh-Hant"
            disabled={picked !== null}
            className={
              picked !== null ? (o === ex.answer ? 'is-right' : o === picked ? 'is-wrong' : '') : ''
            }
            onClick={() => {
              setPicked(o);
              onAnswer(o === ex.answer);
            }}
          >
            {o}
          </button>
        ))}
      </div>
      {picked !== null && (
        <p lang="zh-Hant" className="textbook-cloze-answered">
          <AnnotatedInline text={`${ex.before}${ex.answer}${ex.after}`} lexicon={lexicon} script={script} textbook />
        </p>
      )}
      {picked !== null && (
        <p role="status">
          {picked === ex.answer ? FEEDBACK_CORRECT : feedbackWrong(ex.answer)}{' '}
          <button onClick={onNext} data-testid="grammar-next">
            {NEXT}
          </button>
        </p>
      )}
    </>
  );
}

/** The book's "put the words in the correct order" exercise. */
function ReorderView({
  zh,
  en,
  lexicon,
  script,
  onAnswer,
  onNext,
}: {
  zh: string;
  en?: string;
  lexicon: Lexicon;
  script: AnnotationScript;
  onAnswer: (ok: boolean) => void;
  onNext: () => void;
}) {
  const [exercise] = useState(() => buildReorderExercise(zh, lexicon));
  const [picked, setPicked] = useState<number[]>([]);
  const [result, setResult] = useState<boolean | null>(null);
  const order = exercise.shuffled;
  const built = picked.map((i) => order[i]).join('');
  const target = exercise.correctOrder.join('');

  function check() {
    const ok = built === target;
    setResult(ok);
    onAnswer(ok);
  }

  return (
    <>
      <p className="textbook-muted">Put the words in the correct order.</p>
      {en && <p>{en}</p>}
      <p className="textbook-cloze" lang="zh-Hant">
        {built || ' '}
      </p>
      <div className="textbook-options">
        {order.map((tok, i) => (
          <button
            key={i}
            lang="zh-Hant"
            disabled={picked.includes(i) || result !== null}
            onClick={() => setPicked([...picked, i])}
          >
            {tok}
          </button>
        ))}
      </div>
      {result === null ? (
        <p>
          <button onClick={() => setPicked(picked.slice(0, -1))} disabled={picked.length === 0}>
            Undo
          </button>{' '}
          <button onClick={check} disabled={picked.length !== order.length}>
            Check
          </button>
        </p>
      ) : (
        <p role="status">
          {result ? FEEDBACK_CORRECT : feedbackWrong(target)}{' '}
          <span lang="zh-Hant" className="textbook-cloze-answered">
            <AnnotatedInline text={target} lexicon={lexicon} script={script} textbook />
          </span>{' '}
          <button onClick={onNext} data-testid="grammar-next">
            {NEXT}
          </button>
        </p>
      )}
    </>
  );
}

/** "Study this" from the home card: the same vocab → grammar → scenario → journal session, for any lesson. */
export function StudyLessonView({ bookId, n, onExit }: { bookId: string; n: number; onExit: () => void }) {
  const lexiconState = useLexicon();
  const textbook = useTextbook();
  const sentencesState = useTextbookSentences();
  if (lexiconState.status !== 'ready' || textbook.status !== 'ready') return <p>Loading…</p>;
  const book = textbook.books.find((b) => b.id === bookId);
  const data = textbook.data.find((d) => d.textbook.id === bookId);
  const lesson = book?.lessons.find((l) => l.n === n);
  if (!book || !data || !lesson) return <p>That lesson isn&apos;t installed.</p>;
  const sentences =
    sentencesState.status === 'ready'
      ? sentencesState.sentences.filter((s) => (s.textbookId ?? 'laixue-1') === bookId)
      : [];
  return (
    <StudySession
      lesson={lesson}
      bookId={bookId}
      data={data}
      lexicon={lexiconState.lexicon}
      sentences={sentences}
      onExit={onExit}
    />
  );
}
