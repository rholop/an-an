import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSaveWhenDone } from '../lib/save-progress.js';
import { isDueListening } from '@anan/core';
import {
  lessonIndex,
  planListenSession,
  studyRank,
  isUsableSentence,
  levelIndex,
  LEVEL_IDS,
  maxVisibleLesson,
  type Exercise,
  type Level,
  type Lexicon,
  type PlanItem,
  type SentenceBankEntry,
  type SkillCard,
} from '@anan/core';
import { describePlanItem, newSessionSeed, requeueAgain, sessionMeta } from '@anan/core';
import { logSessionOrder, recentShown } from '../lib/session-recent.js';
import { ListenExercise, type ListenResult } from '../components/ListenExercise.js';
import { learnerService } from '../db/instance.js';
import { ensureListeningCards, recordListeningEvidence, prefetchClips, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { getStudyBooks, getStudyFocusNow } from '../lib/study.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useSentenceBank } from '../lib/useSentenceBank.js';
import { sentenceOrdinal, useTextbookSentences } from '../lib/textbook-data.js';
import { useClassScope, useStudyFocus } from '../lib/study.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { excludedZh } from '../lib/cloze-reports.js';
import { db } from '../db/instance.js';
import { CURRENT_LESSON, UNDO, YOUR_LEVEL, levelShort, lessonLabel, stepName } from '../lib/labels.js';

type Clips = ReturnType<typeof useListeningClips>;

/** The clip an exercise plays, under Phase 15's rules (tone exercises: verified clips only). */
export function exerciseClip(clips: Clips, e: Exercise) {
  switch (e.type) {
    case 'hear_pick':
    case 'hear_type':
      return withUrl(clips, 'word', e.wordId, false);
    case 'tone_check':
      return withUrl(clips, 'word', e.wordId, true);
    case 'tone_pair':
      return withUrl(clips, 'word', e.play === 'a' ? e.a : e.b, true);
    case 'sentence_dictation':
    case 'listen_understand':
      return withUrl(clips, 'sentence', e.sentenceId, false);
  }
}
function withUrl(clips: Clips, kind: 'word' | 'sentence', id: string, verifiedOnly: boolean) {
  const url = clips.urlFor(kind, id, verifiedOnly);
  const info = clips.clipInfo(kind, id);
  return url && info ? { url, kind, id, hash: info.hash, text: info.text } : null;
}

/** Runs a plan: records evidence, skips "Sounds wrong" clips without penalty.
 * Phase 21: a wrong answer comes back once at the end (Again), and Undo takes back the last answer. */
export function ListenRunner({
  plan,
  lexicon,
  clips,
  cardIds,
  onFinished,
  onEach,
  requeue = true,
}: {
  plan: PlanItem[];
  lexicon: Lexicon;
  clips: Clips;
  /** Items that have a listening card (evidence is recorded for these only). */
  cardIds: ReadonlySet<string>;
  onFinished: (summary: { done: number; correct: number; skipped: number }) => void;
  onEach?: () => void;
  /** Phase 21: re-queue a missed exercise at the end (off for one-off slots inside Cloze). */
  requeue?: boolean;
}) {
  const [queue, setQueue] = useState<PlanItem[]>(plan);
  const [i, setI] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [tally, setTally] = useState({ done: 0, correct: 0, skipped: 0 });
  const [history, setHistory] = useState<
    Array<{ i: number; queue: PlanItem[]; tally: typeof tally; undos: Array<() => Promise<void>> }>
  >([]);
  const item = queue[i];

  const advance = useCallback(
    async (r: ListenResult) => {
      const now = new Date();
      const undos: Array<() => Promise<void>> = [];
      await recordListeningEvidence(
        async (e, at) => {
          const h = await learnerService.recordUndoable(e, at);
          undos.push(h.undo);
        },
        cardIds,
        r.evidence,
        now,
      );
      const t = {
        done: tally.done + (r.skipped ? 0 : 1),
        correct: tally.correct + (r.correct ? 1 : 0),
        skipped: tally.skipped + (r.skipped ? 1 : 0),
      };
      // Again (Phase 21): a miss comes back once, spaced from its siblings by the shared rule.
      const missed = requeue && !r.skipped && !r.correct && item && queue.filter((q) => q === item).length < 2;
      const spaced = missed ? requeueAgain(queue, i, describePlanItem) : queue;
      const nextQueue = missed && item ? (spaced.length > queue.length ? spaced : [...queue, item]) : queue;
      setHistory((h) => (r.skipped ? h : [...h, { i, queue, tally, undos }]));
      setTally(t);
      setQueue(nextQueue);
      onEach?.();
      if (i + 1 >= nextQueue.length) onFinished(t);
      else setI(i + 1);
    },
    [cardIds, i, item, onEach, onFinished, queue, requeue, tally],
  );

  async function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    for (const u of last.undos) await u();
    setQueue(last.queue);
    setTally(last.tally);
    setI(last.i);
    setAttempt((a) => a + 1);
    onEach?.();
  }

  // An exercise whose clip has vanished (flagged elsewhere) is skipped without penalty.
  useEffect(() => {
    if (item && !exerciseClip(clips, item.exercise)) void advance({ evidence: [], skipped: true, correct: false });
  }, [item, clips, advance]);

  if (!item) return null;
  return (
    <div>
      <p className="textbook-muted">
        Exercise {i + 1} of {queue.length}{' '}
        {history.length > 0 && (
          <button type="button" className="link-button" data-testid="listen-undo" onClick={() => void undo()}>
            {UNDO}
          </button>
        )}
      </p>
      <ListenExercise
        key={`${i}:${attempt}`}
        exercise={item.exercise}
        lexicon={lexicon}
        clipFor={(e) => exerciseClip(clips, e)}
        wordIdOf={(e) =>
          e.type === 'tone_pair' ? [e.play === 'a' ? e.a : e.b] : e.type === 'sentence_dictation' || e.type === 'listen_understand' ? item.wordIds : [e.wordId]
        }
        onDone={(r) => void advance(r)}
      />
    </div>
  );
}

/** Phase 15: the "Listen" session — due listening cards first, then new ones, mixed exercise types. */
export function ListenPage({
  onExit,
  onlyWordIds,
  title = 'Listen',
  size,
  exitLabel = '← Back',
}: {
  onExit?: () => void;
  onlyWordIds?: ReadonlySet<string>;
  title?: string;
  size?: number;
  exitLabel?: string;
}) {
  const lexiconState = useLexicon();
  const clips = useListeningClips();
  const enabled = useListeningEnabled();
  // Phase 21: sentences up to your level and never past the class (or the active lesson without one).
  const { level } = useCurrentLevel();
  const levels = useMemo((): Level[] => LEVEL_IDS.filter((l) => levelIndex(l) <= levelIndex(level)), [level]);
  const bank = useSentenceBank(levels);
  const tbSentences = useTextbookSentences(true);
  const scope = useClassScope();
  const { focus } = useStudyFocus();
  const [excluded, setExcluded] = useState<Set<string> | null>(null);
  useEffect(() => {
    void excludedZh(db).then(setExcluded);
  }, []);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [cardIds, setCardIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<{ done: number; correct: number; skipped: number } | null>(null);
  useSaveWhenDone(summary !== null); // Phase 28

  const sentences: SentenceBankEntry[] = useMemo(() => {
    const active = focus?.enabled ? focus.activeLesson : undefined;
    const limit = scope.enabled ? maxVisibleLesson(scope) : (active?.ordinal ?? 0);
    const ex = excluded ?? new Set<string>();
    return [
      ...(bank.status === 'ready' ? bank.sentences : []),
      ...(tbSentences.status === 'ready'
        ? tbSentences.sentences.filter((x) => (sentenceOrdinal(x) ?? Infinity) <= limit)
        : []),
    ].filter((x) => isUsableSentence(x.zh, ex));
  }, [bank, tbSentences, scope, focus, excluded]);
  const sentencesReady = bank.status === 'ready' && tbSentences.status === 'ready' && excluded !== null;

  useEffect(() => {
    if (lexiconState.status !== 'ready' || !clips.ready || !enabled || !sentencesReady || plan !== null) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const listening = await ensureListeningCards(clips.hasClip, now);
      const focus = await getStudyFocusNow(now);
      const idx = lessonIndex(getStudyBooks());
      const rank = focus?.enabled
        ? (id: string) => studyRank(focus, (it) => idx.get(`${it.kind}:${it.id}`), { kind: 'word', id })
        : undefined;
      const practiced = listening.filter((c: SkillCard) => isDueListening(c, now));
      const fresh = listening.filter((c) => c.card.reps === 0).map((c) => c.item.id);
      const lessonFresh = onlyWordIds ? [...onlyWordIds].filter((id) => !listening.some((c) => c.item.id === id)) : [];
      const seed = newSessionSeed('listen');
      const p = planListenSession({
        seed,
        recent: recentShown(now),
        lexicon: lexiconState.lexicon,
        dueListening: practiced,
        newWordIds: [...fresh, ...lessonFresh],
        hasClip: clips.hasClip,
        sentences,
        ...(rank ? { rank } : {}),
        ...(onlyWordIds ? { onlyWordIds } : {}),
        ...(size ? { size } : {}),
      });
      if (cancelled) return;
      logSessionOrder('listen', seed, p.length, sessionMeta(p)?.deferred.length ?? 0);
      setCardIds(new Set(listening.map((c) => c.item.id)));
      setPlan(p);
      // So the session works offline: warm the service-worker cache with every clip it needs.
      prefetchClips(p.flatMap((x) => { const c = exerciseClip(clips, x.exercise); return c ? [c.url] : []; }));
    })();
    return () => {
      cancelled = true;
    };
    // the plan is built once per session start
  }, [lexiconState.status, clips.ready, enabled, sentencesReady]);

  if (lexiconState.status !== 'ready') return <p>Loading…</p>;
  return (
    <div className="listen-page" data-testid="listen-page">
      {onExit && <button onClick={onExit}>{exitLabel}</button>}
      <h1>{title}</h1>
      <p className="textbook-muted" data-testid="listen-context">
        {YOUR_LEVEL}: {levelShort(level)}
        {focus?.enabled && focus.activeStep && (
          <>
            {' · '}
            {CURRENT_LESSON}:{' '}
            {focus.activeLesson ? lessonLabel(focus.activeLesson.n, focus.activeLesson.bookId) : stepName(focus.activeStep)}
          </>
        )}
      </p>
      {!enabled ? (
        <p>Listening practice is off (Credits → Audio).</p>
      ) : !clips.ready ? (
        <p>No audio has been built, so there is nothing to listen to yet.</p>
      ) : plan === null ? (
        <p>Loading…</p>
      ) : summary ? (
        <p role="status" data-testid="listen-summary">
          Done: {summary.correct} of {summary.done} right{summary.skipped ? ` · ${summary.skipped} skipped` : ''}.{' '}
          {onExit && <button onClick={onExit}>{exitLabel}</button>}
        </p>
      ) : plan.length === 0 ? (
        <p data-testid="listen-empty">
          Nothing to practise yet. Words join Listen once you know them well enough to review and a verified clip exists.
        </p>
      ) : (
        <ListenRunner plan={plan} lexicon={lexiconState.lexicon} clips={clips} cardIds={cardIds} onFinished={setSummary} />
      )}
    </div>
  );
}
