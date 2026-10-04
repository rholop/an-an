import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  lessonIndex,
  planListenSession,
  studyRank,
  type Exercise,
  type Level,
  type Lexicon,
  type PlanItem,
  type SentenceBankEntry,
  type SkillCard,
} from '@anan/core';
import { ListenExercise, type ListenResult } from '../components/ListenExercise.js';
import { learnerService } from '../db/instance.js';
import { ensureListeningCards, prefetchClips, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { getStudyBooks, getStudyFocusNow } from '../lib/study.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useSentenceBank } from '../lib/useSentenceBank.js';
import { useTextbookSentences } from '../lib/textbook-data.js';

const SENTENCE_LEVELS: Level[] = ['N1', 'N2', 'L1', 'L2'];
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

/** Runs a plan: records evidence, skips "Sounds wrong" clips without penalty. */
export function ListenRunner({
  plan,
  lexicon,
  clips,
  cardIds,
  onFinished,
  onEach,
}: {
  plan: PlanItem[];
  lexicon: Lexicon;
  clips: Clips;
  /** Items that have a listening card (evidence is recorded for these only). */
  cardIds: ReadonlySet<string>;
  onFinished: (summary: { done: number; correct: number; skipped: number }) => void;
  onEach?: () => void;
}) {
  const [i, setI] = useState(0);
  const [tally, setTally] = useState({ done: 0, correct: 0, skipped: 0 });
  const item = plan[i];

  const advance = useCallback(
    async (r: ListenResult) => {
      const now = new Date();
      for (const e of r.evidence)
        if (cardIds.has(e.wordId))
          await learnerService.record({ item: { kind: 'word', id: e.wordId }, skill: 'listening', kind: e.kind, at: now }, now);
      const t = {
        done: tally.done + (r.skipped ? 0 : 1),
        correct: tally.correct + (r.correct ? 1 : 0),
        skipped: tally.skipped + (r.skipped ? 1 : 0),
      };
      setTally(t);
      onEach?.();
      if (i + 1 >= plan.length) onFinished(t);
      else setI(i + 1);
    },
    [cardIds, i, onEach, onFinished, plan.length, tally],
  );

  // An exercise whose clip has vanished (flagged elsewhere) is skipped without penalty.
  useEffect(() => {
    if (item && !exerciseClip(clips, item.exercise)) void advance({ evidence: [], skipped: true, correct: false });
  }, [item, clips, advance]);

  if (!item) return null;
  return (
    <div>
      <p className="textbook-muted">
        Exercise {i + 1} of {plan.length}
      </p>
      <ListenExercise
        key={i}
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
  const bank = useSentenceBank(SENTENCE_LEVELS);
  const tbSentences = useTextbookSentences(true);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [cardIds, setCardIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<{ done: number; correct: number; skipped: number } | null>(null);

  const sentences: SentenceBankEntry[] = useMemo(
    () => [
      ...(bank.status === 'ready' ? bank.sentences : []),
      ...(tbSentences.status === 'ready' ? tbSentences.sentences : []),
    ],
    [bank, tbSentences],
  );

  useEffect(() => {
    if (lexiconState.status !== 'ready' || !clips.ready || !enabled) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const listening = await ensureListeningCards(clips.hasClip, now);
      const focus = await getStudyFocusNow(now);
      const idx = lessonIndex(getStudyBooks());
      const rank = focus?.enabled
        ? (id: string) => studyRank(focus, (it) => idx.get(`${it.kind}:${it.id}`), { kind: 'word', id })
        : undefined;
      const practiced = listening.filter((c: SkillCard) => c.card.reps > 0 && c.card.due <= now);
      const fresh = listening.filter((c) => c.card.reps === 0).map((c) => c.item.id);
      const lessonFresh = onlyWordIds ? [...onlyWordIds].filter((id) => !listening.some((c) => c.item.id === id)) : [];
      const p = planListenSession({
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
      setCardIds(new Set(listening.map((c) => c.item.id)));
      setPlan(p);
      // So the session works offline: warm the service-worker cache with every clip it needs.
      prefetchClips(p.flatMap((x) => { const c = exerciseClip(clips, x.exercise); return c ? [c.url] : []; }));
    })();
    return () => {
      cancelled = true;
    };
    // the plan is built once per session start
  }, [lexiconState.status, clips.ready, enabled]);

  if (lexiconState.status !== 'ready') return <p>Loading…</p>;
  return (
    <div className="listen-page" data-testid="listen-page">
      {onExit && <button onClick={onExit}>{exitLabel}</button>}
      <h1>{title}</h1>
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
