import { useEffect, useState } from 'react';
import {
  checkGrammarAnswer,
  extraExercise,
  fillSlots,
  grammarDots,
  grammarOutcome,
  PROGRESS_CONFIG,
  zonedDay,
  type FillExercise,
  type GrammarStepExercise,
  type Lesson,
  type Lexicon,
  type PickExercise,
  type SentenceBankEntry,
  type TileExercise,
} from '@anan/core';
import { AnnotatedInline, useReadingScript } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { GrammarDots } from '../components/GrammarDots.js';
import { db, learnerService } from '../db/instance.js';
import { excludedZh } from '../lib/cloze-reports.js';
import {
  CHECK,
  FEEDBACK_CORRECT,
  feedbackWrong,
  GRAMMAR_BUILD_PROMPT,
  GRAMMAR_PICK_PROMPT,
  GRAMMAR_REORDER_PROMPT,
  grammarPointOutcome,
  grammarStepPosition,
  NEXT,
  SKIP,
  UNDO,
} from '../lib/labels.js';
import { useReviewSettings } from '../lib/review-settings.js';
import { logSessionOrder, noteShown } from '../lib/session-recent.js';
import { useProgressData } from '../lib/study.js';
import { fetchPrivateTextbook, loadTextbookSentences, useTextbook, type BookData, type PrivateExample } from '../lib/textbook-data.js';
import './TextbookPage.css';
import { buildLessonGrammarStep, buildSingleGrammarExercise, type LessonGrammarStep } from '../lib/textbook-session.js';

const NEED = PROGRESS_CONFIG.mastered.grammarCorrectUses;

interface Snapshot {
  idx: number;
  queue: GrammarStepExercise[];
  tally: { right: number; wrong: number };
  undo: () => Promise<void>;
}

/**
 * Phase 25: the lesson grammar step. 3 exercises per grammar point (fill the pattern, reorder,
 * which sentence is right, build it from English), round-robin, each on a different sentence. A miss
 * comes back once at the end on another sentence ("7 of 9 · +1 extra"); Undo takes the extra away.
 */
export function GrammarStep({
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
  /** null while the lesson sentences are still loading. */
  sentences: SentenceBankEntry[] | null;
  onDone: () => void;
}) {
  const script = useReadingScript();
  const textbook = useTextbook();
  const progress = useProgressData();
  const { timeZone } = useReviewSettings();
  const books = textbook.status === 'ready' ? textbook.books : null;
  const [step, setStep] = useState<LessonGrammarStep | null>(null);
  const [queue, setQueue] = useState<GrammarStepExercise[]>([]);
  const [idx, setIdx] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [tally, setTally] = useState({ right: 0, wrong: 0 });
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [privateEx, setPrivateEx] = useState<PrivateExample[]>([]);

  // Built once the sentences (and the books, for the tiles) are loaded: never from an empty list.
  const ready = sentences !== null && books !== null;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void excludedZh(db).then((excluded) => {
      if (cancelled) return;
      const built = buildLessonGrammarStep(lesson, data.grammarItems, sentences, { lexicon, bookId, books, excluded });
      logSessionOrder('lesson-grammar', built.seed, built.plan.exercises.length, 0);
      setStep(built);
      setQueue(built.plan.exercises);
      setIdx(0);
      setTally({ right: 0, wrong: 0 });
      setHistory([]);
    });
    return () => {
      cancelled = true;
    };
    // rebuilt only when the lesson or its loaded sentences change, not on every render
  }, [lesson.id, bookId, ready, sentences?.length]);

  // The book's own worked examples (private), shown after the step when available.
  useEffect(() => {
    void fetchPrivateTextbook<Record<string, PrivateExample[]>>('examples', bookId).then((r) => {
      if (r.status === 'ok') setPrivateEx((r.data[lesson.id] ?? []).filter((e) => !/[A-Za-z]/.test(e.zh)).slice(0, 3));
    });
  }, [lesson.id, bookId]);

  if (!step) return <p>Loading…</p>;
  const base = step.plan.exercises.length;
  const current = queue[idx];
  const pattern = (id: string) => data.grammarItems.find((g) => g.id === id)?.pattern ?? id;

  async function record(ex: GrammarStepExercise, correct: boolean) {
    if (!step) return;
    const now = new Date();
    noteShown([`grammar:${ex.grammarId}`], now);
    const { undo } = await learnerService.recordUndoable(
      {
        item: { kind: 'grammar', id: ex.grammarId },
        skill: 'recognition',
        kind: correct ? 'cloze_correct_nohint' : 'cloze_wrong',
        at: now,
        context: { source: 'textbook', refId: lesson.id },
      },
      now,
    );
    setHistory((h) => [...h, { idx, queue, tally, undo }]);
    // A miss on one of the planned exercises comes back once, at the end, on another sentence.
    if (!correct && idx < base) {
      const extra = extraExercise(step.plan, ex, step.inputs, new Set(queue.map((e) => e.sentenceId)));
      if (extra) setQueue([...queue, extra]);
    }
    setTally((t) => ({ right: t.right + (correct ? 1 : 0), wrong: t.wrong + (correct ? 0 : 1) }));
  }

  async function undoLast() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    await last.undo();
    setQueue(last.queue);
    setTally(last.tally);
    setIdx(last.idx);
    setAttempt((a) => a + 1);
  }

  if (base === 0)
    return (
      <p data-testid="grammar-empty">
        No practice sentences for this lesson yet. <button onClick={onDone}>{NEXT}</button>
      </p>
    );

  if (!current) {
    const today = zonedDay(new Date(), timeZone);
    return (
      <div className="textbook-grammar-done" role="status" data-testid="grammar-step-done">
        <p>
          Grammar practice done: {tally.right} right, {tally.wrong} to revisit.
        </p>
        <ul className="grammar-outcomes">
          {lesson.grammar.map((id) => {
            const use = progress?.grammarUses.get(id);
            return (
              <li key={id} data-testid="grammar-outcome">
                <GrammarDots use={use} />{' '}
                <span lang="zh-Hant">{grammarPointOutcome(pattern(id), grammarDots(use), NEED, grammarOutcome(use, today))}</span>
              </li>
            );
          })}
        </ul>
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
  }

  const next = () => setIdx(idx + 1);
  const answer = (ok: boolean) => void record(current, ok);
  const key = `${idx}:${attempt}`;
  return (
    <div
      className="textbook-exercise"
      data-testid="grammar-exercise"
      data-type={current.type}
      data-grammar={current.grammarId}
      data-sentence={current.sentenceId}
    >
      <p className="textbook-muted">
        <span data-testid="grammar-position">{grammarStepPosition(idx + 1, base, queue.length - base)}</span> ·{' '}
        <span lang="zh-Hant">{pattern(current.grammarId)}</span>{' '}
        <GrammarDots use={progress?.grammarUses.get(current.grammarId)} testId="grammar-current-dots" />{' '}
        {history.length > 0 && (
          <button type="button" className="link-button" data-testid="grammar-undo" onClick={() => void undoLast()}>
            {UNDO}
          </button>
        )}
      </p>
      {current.type === 'fill' ? (
        <FillView key={key} ex={current} lexicon={lexicon} script={script} onAnswer={answer} onNext={next} />
      ) : current.type === 'pick' ? (
        <PickView key={key} ex={current} lexicon={lexicon} script={script} onAnswer={answer} onNext={next} />
      ) : (
        <TileView key={key} ex={current} lexicon={lexicon} script={script} onAnswer={answer} onNext={next} />
      )}
    </div>
  );
}

interface ViewProps<E> {
  ex: E;
  lexicon: Lexicon;
  script: AnnotationScript;
  onAnswer: (ok: boolean) => void;
  onNext: () => void;
}

function Result({ ok, zh, lexicon, script, onNext }: { ok: boolean; zh: string; lexicon: Lexicon; script: AnnotationScript; onNext: () => void }) {
  return (
    <p role="status">
      {ok ? FEEDBACK_CORRECT : feedbackWrong(zh)}{' '}
      <span lang="zh-Hant" className="textbook-cloze-answered">
        <AnnotatedInline text={zh} lexicon={lexicon} script={script} textbook />
      </span>{' '}
      <button onClick={onNext} data-testid="grammar-next">
        {NEXT}
      </button>
    </p>
  );
}

/** Fill the pattern: the blank comes from the grammar matcher's span. */
function FillView({ ex, lexicon, script, onAnswer, onNext }: ViewProps<FillExercise>) {
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
            data-testid="grammar-option"
            className={picked !== null ? (o === ex.answer ? 'is-right' : o === picked ? 'is-wrong' : '') : ''}
            onClick={() => {
              setPicked(o);
              onAnswer(checkGrammarAnswer(ex, o));
            }}
          >
            {o}
          </button>
        ))}
      </div>
      {picked !== null && <Result ok={checkGrammarAnswer(ex, picked)} zh={ex.zh} lexicon={lexicon} script={script} onNext={onNext} />}
    </>
  );
}

/** Which sentence is right? One correct sentence, one with a typical error for the point. */
function PickView({ ex, lexicon, script, onAnswer, onNext }: ViewProps<PickExercise>) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <>
      <p className="textbook-muted">{GRAMMAR_PICK_PROMPT}</p>
      {ex.en && <p>{ex.en}</p>}
      <div className="textbook-options textbook-options-stacked">
        {ex.options.map((o, i) => (
          <button
            key={i}
            lang="zh-Hant"
            disabled={picked !== null}
            data-testid="grammar-option"
            className={picked !== null ? (i === ex.correctIndex ? 'is-right' : i === picked ? 'is-wrong' : '') : ''}
            onClick={() => {
              setPicked(i);
              onAnswer(checkGrammarAnswer(ex, i));
            }}
          >
            {o}
          </button>
        ))}
      </div>
      {picked !== null && <Result ok={checkGrammarAnswer(ex, picked)} zh={ex.zh} lexicon={lexicon} script={script} onNext={onNext} />}
    </>
  );
}

/** Reorder (punctuation fixed in place) and Build it from English (one tile is not needed). */
function TileView({ ex, lexicon, script, onAnswer, onNext }: ViewProps<TileExercise>) {
  const [picked, setPicked] = useState<number[]>([]);
  const [result, setResult] = useState<boolean | null>(null);
  const open = ex.slots.filter((s) => s === null).length;
  const words = picked.map((i) => ex.tiles[i]!);
  let k = 0;
  return (
    <>
      <p className="textbook-muted">{ex.type === 'build' ? GRAMMAR_BUILD_PROMPT : GRAMMAR_REORDER_PROMPT}</p>
      {ex.en && <p className={ex.type === 'build' ? 'textbook-build-en' : undefined}>{ex.en}</p>}
      <p className="textbook-cloze textbook-slots" lang="zh-Hant" data-testid="grammar-built">
        {ex.slots.map((s, i) =>
          s === null ? (
            <span key={i} className="textbook-slot">
              {words[k++] ?? '＿'}
            </span>
          ) : (
            <span key={i} className="textbook-slot-fixed">
              {s}
            </span>
          ),
        )}
      </p>
      <div className="textbook-options">
        {ex.tiles.map((tok, i) => (
          <button
            key={i}
            lang="zh-Hant"
            data-testid="grammar-tile"
            disabled={picked.includes(i) || result !== null || picked.length >= open}
            onClick={() => setPicked([...picked, i])}
          >
            {tok}
          </button>
        ))}
      </div>
      {result === null ? (
        <p>
          <button onClick={() => setPicked(picked.slice(0, -1))} disabled={picked.length === 0}>
            {UNDO}
          </button>{' '}
          <button
            data-testid="grammar-check"
            disabled={picked.length !== open}
            onClick={() => {
              const ok = checkGrammarAnswer(ex, words);
              setResult(ok);
              onAnswer(ok);
            }}
          >
            {CHECK}
          </button>
        </p>
      ) : (
        <Result ok={result} zh={result ? fillSlots(ex.slots, words) : ex.zh} lexicon={lexicon} script={script} onNext={onNext} />
      )}
    </>
  );
}

/**
 * Phase 25 B7: one exercise for a grammar point (Review and Cloze). undefined while loading, null when
 * the point has no textbook sentences (the caller falls back to its own card).
 */
export function useSingleGrammarExercise(grammarId: string | undefined, lexicon: Lexicon, seed: string): GrammarStepExercise | null | undefined {
  const textbook = useTextbook();
  const want = `${grammarId ?? ''}|${seed}`;
  // Keyed by what was asked, so a new point never shows the previous point's exercise.
  const [got, setGot] = useState<{ key: string; ex: GrammarStepExercise | null } | null>(null);
  useEffect(() => {
    if (!grammarId || textbook.status === 'missing') return setGot({ key: want, ex: null });
    if (textbook.status !== 'ready') return;
    let cancelled = false;
    void Promise.all([loadTextbookSentences(), excludedZh(db)]).then(([sentences, excluded]) => {
      if (cancelled) return;
      const items = textbook.data.flatMap((d) => d.grammarItems);
      setGot({ key: want, ex: buildSingleGrammarExercise(grammarId, items, sentences, { lexicon, books: textbook.books, seed, excluded }) ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [want, textbook.status]);
  if (!grammarId) return null;
  return got?.key === want ? got.ex : undefined;
}

/** One grammar exercise outside the lesson step: answer, see the sentence, then Next reports it. */
export function GrammarExerciseCard({
  ex,
  lexicon,
  script,
  onDone,
}: {
  ex: GrammarStepExercise;
  lexicon: Lexicon;
  script: AnnotationScript;
  onDone: (ok: boolean) => void;
}) {
  const [ok, setOk] = useState<boolean | null>(null);
  const props = { lexicon, script, onAnswer: (r: boolean) => setOk(r), onNext: () => ok !== null && onDone(ok) };
  return (
    <div className="textbook-exercise" data-testid="grammar-exercise" data-type={ex.type} data-grammar={ex.grammarId} data-sentence={ex.sentenceId}>
      {ex.type === 'fill' ? <FillView ex={ex} {...props} /> : ex.type === 'pick' ? <PickView ex={ex} {...props} /> : <TileView ex={ex} {...props} />}
    </div>
  );
}

const ROUND_SIZE = 3;

/**
 * Phase 25 B7: in Cloze, Learned but not yet Mastered grammar points come back as one exercise each
 * (at most 3 a visit), before the cloze session. Their right answers count toward the dots.
 */
export function GrammarRound({ lexicon }: { lexicon: Lexicon }) {
  const progress = useProgressData();
  const script = useReadingScript();
  const [ids, setIds] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!progress || ids) return;
    const g = (id: string) => ({ kind: 'grammar' as const, id });
    const open = [...progress.grammarUses.keys()].filter((id) => progress.index.learned(g(id)) && !progress.index.mastered(g(id)) && !progress.index.removed(g(id)));
    setIds(open.slice(0, ROUND_SIZE));
  }, [progress, ids]);
  const id = ids?.[i];
  const ex = useSingleGrammarExercise(id, lexicon, `cloze|${id ?? ''}|${round}`);
  // a point with no sentence: move on
  useEffect(() => {
    if (id && ex === null) setI((k) => k + 1);
  }, [id, ex]);
  if (!ids || ids.length === 0 || skipped || !id || !ex) return ex === undefined && id && !skipped ? <p>Loading…</p> : null;
  const pattern = lexicon.grammarItemById(id)?.pattern ?? id;
  async function done(ok: boolean) {
    const now = new Date();
    await learnerService.record(
      { item: { kind: 'grammar', id: id! }, skill: 'recognition', kind: ok ? 'cloze_correct_nohint' : 'cloze_wrong', at: now, context: { source: 'cloze' } },
      now,
    );
    setI((k) => k + 1);
    setRound((r) => r + 1);
  }
  return (
    <section className="grammar-round" data-testid="grammar-round" aria-label="Grammar practice">
      <p className="textbook-muted">
        Grammar practice · {i + 1} of {ids.length} · <span lang="zh-Hant">{pattern}</span>{' '}
        <GrammarDots use={progress?.grammarUses.get(id)} />{' '}
        <button type="button" className="link-button" data-testid="grammar-round-skip" onClick={() => setSkipped(true)}>
          {SKIP}
        </button>
      </p>
      <GrammarExerciseCard key={`${id}:${round}`} ex={ex} lexicon={lexicon} script={script} onDone={(ok) => void done(ok)} />
    </section>
  );
}
