import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildReorderExercise,
  classLevelHint,
  classScope,
  courseBook,
  courseLessonLevel,
  courseOrdinal,
  LAIXUE_COURSE,
  levelLabel,
  lessonBadge,
  lessonDone,
  lessonProgress,
  type GrammarItem,
  type Lesson,
  type LessonProgress,
  type Lexicon,
  type SentenceBankEntry,
  type SkillCard,
  type Textbook,
  type Word,
} from '@anan/core';
import { AnnotatedInline, AnnotatedWord, useReadingScript } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { db, learnerService } from '../db/instance.js';
import { allTouchedCards } from '../db/queries.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { setMyClass, useMyClass } from '../lib/my-class.js';
import { buildGrammarExercises, type GrammarExercise } from '../lib/textbook-session.js';
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
import { JournalPage } from './JournalPage.js';
import { ReviewPage } from './ReviewPage.js';
import './TextbookPage.css';

type View =
  | { kind: 'path' }
  | { kind: 'lesson'; bookId: string; n: number }
  | { kind: 'study'; bookId: string; n: number };

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function TextbookPage() {
  const lexiconState = useLexicon();
  const textbook = useTextbook();
  const myClass = useMyClass();
  const sentencesState = useTextbookSentences();
  const script = useReadingScript();
  const [view, setView] = useState<View>({ kind: 'path' });
  const [progress, setProgress] = useState<Map<string, LessonProgress>>(new Map());
  const [tick, setTick] = useState(0);

  // Per-lesson progress: vocab in review, grammar practised, scenarios, prompts.
  useEffect(() => {
    if (textbook.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const [cards, convs, entries] = await Promise.all([
        allTouchedCards(db),
        db.conversations.toArray(),
        db.journalEntries.where('status').equals('finished').toArray(),
      ]);
      if (cancelled) return;
      const completedScenarioIds = new Set(
        convs.filter((c) => c.completed).map((c) => c.scenarioId),
      );
      const donePromptIds = new Set(entries.flatMap((e) => (e.promptId ? [e.promptId] : [])));
      setProgress(
        new Map(
          textbook.books.flatMap((b) =>
            b.lessons.map((l) => [
              l.id,
              lessonProgress(l, { cards, completedScenarioIds, donePromptIds }),
            ] as const),
          ),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [textbook, tick, view.kind]);

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
  const scope = classScope(myClass);

  if (view.kind === 'study') {
    const book = books.find((b) => b.id === view.bookId)!;
    const lesson = book.lessons[view.n - 1]!;
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
    return (
      <LessonDetail
        lesson={book.lessons[view.n - 1]!}
        bookId={view.bookId}
        data={allData.find((d) => d.textbook.id === view.bookId)!}
        lexicon={lexicon}
        sentences={sentences.filter((s) => (s.textbookId ?? 'laixue-1') === view.bookId)}
        script={script}
        classOn={myClass.enabled}
        progress={progress.get(book.lessons[view.n - 1]!.id)}
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
          {myClass.textbookId === 'laixue-1'
            ? `We're on lesson ${myClass.currentLesson} in class.`
            : `We're on lesson ${myClass.currentLesson} of ${courseBook(LAIXUE_COURSE, myClass.textbookId)?.titleZh ?? myClass.textbookId} in class.`}
        </p>
      )}
      {books.length > 1 && (
        <nav className="textbook-books" aria-label="Books" data-testid="book-picker">
          {books.map((b) => {
            const cb = courseBook(LAIXUE_COURSE, b.id);
            return (
              <button key={b.id} type="button" onClick={() => jump(b.id)} data-testid={`book-${b.id}`}>
                <span lang="zh-Hant">{b.titleZh}</span>
                {cb && <small> · {cb.levelLabel}</small>}
              </button>
            );
          })}
        </nav>
      )}
      {books.map((book) => {
        const cb = courseBook(LAIXUE_COURSE, book.id);
        const done = book.lessons.filter((l) => {
          const p = progress.get(l.id);
          return p && lessonDone(p);
        }).length;
        return (
          <section key={book.id} id={`textbook-book-${book.id}`} className="textbook-book" aria-label={book.titleEn}>
            <h2>
              <span lang="zh-Hant">{book.titleZh}</span> <small>{book.titleEn}</small>
            </h2>
            <p className="textbook-muted" data-testid={`book-progress-${book.id}`}>
              {cb ? `${cb.levelLabel} · ` : ''}
              {done} of {book.lessons.length} lessons done
            </p>
            <ol className="textbook-path">
              {book.lessons.map((l) => {
                const p = progress.get(l.id);
                const ord = courseOrdinal(LAIXUE_COURSE, book.id, l.n) ?? 0;
                const state = !myClass.enabled
                  ? 'idle'
                  : ord < scope.currentLesson
                    ? 'past'
                    : ord === scope.currentLesson
                      ? 'now'
                      : ord === scope.currentLesson + 1
                        ? 'next'
                        : 'later';
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
                      {state === 'now' && <span className="textbook-chip">this week</span>}
                      {state === 'next' && (
                        <span className="textbook-chip textbook-chip--soft">next</span>
                      )}
                      {p && lessonDone(p) && (
                        <span className="textbook-chip textbook-chip--good">done</span>
                      )}
                    </button>
                    {p && myClass.enabled && <ProgressRow p={p} />}
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

function ProgressRow({ p }: { p: LessonProgress }) {
  return (
    <div className="textbook-progress" aria-label="Lesson progress">
      <div className="textbook-bar" title="Vocabulary in review or better">
        <span style={{ width: pct(p.vocabShare) }} />
      </div>
      <span>
        Vocab {pct(p.vocabShare)} · Grammar {p.grammarPractised}/{p.grammarTotal} · Scenarios{' '}
        {p.scenariosDone}/{p.scenariosTotal} · Journal {p.promptsDone}/{p.promptsTotal}
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
    const { added } = await setMyClass(patch, { books, recorder: learnerService });
    setNote(
      next.enabled && added > 0
        ? `Added ${added} words and grammar points from the lessons up to ${lessonBadge(next.currentLesson, next.textbookId)} to your reviews.`
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
                {b.titleZh}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Current lesson in class:{' '}
        <select
          value={myClass.currentLesson}
          onChange={(e) => void apply({ currentLesson: Number(e.target.value) })}
          data-testid="my-class-lesson"
        >
          {book.lessons.map((l) => (
            <option key={l.id} value={l.n}>
              {l.n}. {l.titleEn}
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
  classOn,
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
  classOn: boolean;
  progress: LessonProgress | undefined;
  onBack: () => void;
  onStudy: () => void;
}) {
  const [checking, setChecking] = useState(false);
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
          {lessonBadge(lesson.n, bookId)}
        </span>{' '}
        <span lang="zh-Hant">{lesson.titleZh}</span> <small>{lesson.titleEn}</small>
      </h1>
      <p className="textbook-muted">Topic: {lesson.topic}</p>
      {progress && classOn && <ProgressRow p={progress} />}
      <button className="textbook-study-btn" onClick={onStudy} data-testid="study-lesson">
        Study this lesson
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
            <span className="textbook-muted">{bookGloss(w)}</span>
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
                <span className="textbook-muted">{bookGloss(w)}</span>
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

function bookGloss(w: Word): string {
  return w.senses?.find((s) => s.id === w.textbookSenseId)?.glossEn ?? w.glossEn;
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
          </span>
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Study this lesson: vocab → grammar cloze/reorder → scenario → journal.
// ---------------------------------------------------------------------------

type Step = 'vocab' | 'grammar' | 'scenario' | 'journal';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'vocab', label: 'Vocabulary review' },
  { id: 'grammar', label: 'Grammar practice' },
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
  // Steps with nothing to do are dropped; the rest can each be skipped.
  const steps = useMemo(
    () =>
      STEPS.filter((s) =>
        s.id === 'scenario'
          ? lesson.scenarios.length > 0
          : s.id === 'journal'
            ? lesson.journalPrompts.length > 0
            : true,
      ),
    [lesson],
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
          <span lang="zh-Hant">{lessonBadge(lesson.n, bookId)}</span> · Step {i + 1} of {steps.length}:{' '}
          {step.label}
        </strong>
        <span>
          <button onClick={next} data-testid="study-skip">
            {i + 1 >= steps.length ? 'Finish' : 'Skip step →'}
          </button>{' '}
          <button onClick={onExit}>Exit</button>
        </span>
      </div>
      {step.id === 'vocab' && <VocabStep lesson={lesson} onDone={next} />}
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

function VocabStep({ lesson, onDone }: { lesson: Lesson; onDone: () => void }) {
  const [cards, setCards] = useState<SkillCard[] | null>(null);
  useEffect(() => {
    (async () => {
      const ids = new Set([...lesson.vocab, ...(lesson.grammarWords ?? [])]);
      const due = await learnerService.dueCards(new Date(), 2000);
      setCards(
        due
          .filter((c) => c.item.kind === 'word' && c.skill === 'recognition' && ids.has(c.item.id))
          .slice(0, 25),
      );
    })();
  }, [lesson]);
  if (!cards) return <p>Loading…</p>;
  if (cards.length === 0)
    return (
      <p>
        Nothing from this lesson is due right now. <button onClick={onDone}>Continue →</button>
      </p>
    );
  return (
    <ReviewPage
      focusCards={cards}
      onExit={onDone}
      exitLabel="Done with vocabulary →"
      title={`Lesson ${lesson.n} vocabulary`}
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
  const { level } = useCurrentLevel();
  void level;
  const [exercises] = useState<GrammarExercise[]>(() =>
    buildGrammarExercises(lesson, data.grammarItems, sentences, { bookId }),
  );
  const [privateEx, setPrivateEx] = useState<PrivateExample[]>([]);
  const [idx, setIdx] = useState(0);
  const [tally, setTally] = useState({ right: 0, wrong: 0 });

  // The book's own worked examples (private) add extra "put the words in order" items when available.
  useEffect(() => {
    fetchPrivateTextbook<Record<string, PrivateExample[]>>('examples', bookId).then((r) => {
      if (r.status === 'ok')
        setPrivateEx((r.data[lesson.id] ?? []).filter((e) => !/[A-Za-z]/.test(e.zh)).slice(0, 3));
    });
  }, [lesson.id, bookId]);

  const total = exercises.length;
  const current = exercises[idx];
  const grammarName = (id: string) => data.grammarItems.find((g) => g.id === id)?.pattern ?? id;

  async function record(grammarId: string, correct: boolean) {
    const now = new Date();
    await learnerService.record(
      {
        item: { kind: 'grammar', id: grammarId },
        skill: 'recognition',
        kind: correct ? 'cloze_correct_nohint' : 'cloze_wrong',
        at: now,
        context: { source: 'textbook', refId: lesson.id },
      },
      now,
    );
    setTally((t) => ({ right: t.right + (correct ? 1 : 0), wrong: t.wrong + (correct ? 0 : 1) }));
  }

  if (total === 0)
    return (
      <p>
        No practice sentences for this lesson yet. <button onClick={onDone}>Continue →</button>
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
          Continue →
        </button>
      </div>
    );

  return (
    <div className="textbook-exercise" data-testid="grammar-exercise">
      <p className="textbook-muted">
        {idx + 1} / {total} · <span lang="zh-Hant">{grammarName(current.grammarId)}</span>
      </p>
      {current.type === 'cloze' ? (
        <ClozeView
          key={idx}
          ex={current}
          onAnswer={(ok) => void record(current.grammarId, ok)}
          onNext={() => setIdx(idx + 1)}
        />
      ) : (
        <ReorderView
          key={idx}
          zh={current.zh}
          en={current.en}
          lexicon={lexicon}
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
}: {
  ex: Extract<GrammarExercise, { type: 'cloze' }>;
  onAnswer: (ok: boolean) => void;
  onNext: () => void;
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
        <p role="status">
          {picked === ex.answer ? (
            'Right!'
          ) : (
            <>
              Not quite — it&apos;s <span lang="zh-Hant">{ex.answer}</span>.
            </>
          )}{' '}
          <button onClick={onNext} data-testid="grammar-next">
            Next →
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
  onAnswer,
  onNext,
}: {
  zh: string;
  en?: string;
  lexicon: Lexicon;
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
          {result ? (
            'Right!'
          ) : (
            <>
              Not quite — <span lang="zh-Hant">{target}</span>.
            </>
          )}{' '}
          <button onClick={onNext} data-testid="grammar-next">
            Next →
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
  const lesson = book?.lessons[n - 1];
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
