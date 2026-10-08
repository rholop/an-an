import { useEffect, useMemo, useRef, useState } from 'react';
import { isDueListening } from '@anan/core';
import {
  describePlanItem,
  describeSkillCard,
  itemKey,
  LISTENING_CONFIG,
  newSessionSeed,
  placeExtras,
  planListenSession,
  planWaterAll,
  ProgressIndex,
  requeueAgain,
  selectClozeSource,
  waterAllCards,
  wateredWordCount,
  type ClozeRung,
  type Evidence,
  type ExerciseKind,
  type Level,
  type Lexicon,
  type PlanItem,
  type SessionItem,
  type SkillCard,
  type WaterEntry,
} from '@anan/core';
import { MiniPlant } from '../components/Celebrations.js';
import { db, learnerService } from '../db/instance.js';
import { allChatLines, allJournalSentences } from '../db/queries.js';
import { excludedZh } from '../lib/cloze-reports.js';
import { nopeWord } from '../lib/nope.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { NOTHING_DUE, UNDO, wateredSummary } from '../lib/labels.js';
import { ensureListeningCards, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { useAnswerInputMode, useReadingSettings } from '../lib/reading.js';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import { useSentenceBank } from '../lib/useSentenceBank.js';
import { ExerciseView, type Outcome } from './ClozePage.js';
import { ListenRunner } from './ListenPage.js';
import { ReviewCard, type Grade } from './ReviewPage.js';
import './WaterAllPage.css';

type Entry = WaterEntry<SessionItem>;

const kindForRung = (rung: ClozeRung): ExerciseKind =>
  rung === 1 ? 'word_bank' : rung === 2 ? 'multiple_choice' : 'typed';
const clozeKind = (o: Outcome): Evidence['kind'] =>
  o === 'correct'
    ? 'cloze_correct_nohint'
    : o === 'correct_wrong_tone'
      ? 'cloze_correct_hint'
      : 'cloze_wrong';
const describeEntry = (e: Entry) => ({ keys: [itemKey(e.card.item)] });

/**
 * Phase 22 Part B: "💧 Water all" — one cute, mixed session (flashcards, clozes and a few
 * listening exercises) over every word in the garden that needs water, at every level and in every
 * plot. A small plant at the top is watered on each correct answer; the end says how many words
 * were watered and how many perked up to Learned.
 */
export function WaterAllPage({ onExit }: { onExit: () => void }) {
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();
  const { level } = useCurrentLevel();
  const [due, setDue] = useState<SkillCard[] | null>(null);
  const [sources, setSources] = useState<{
    knownIds: Set<string>;
    chat: Awaited<ReturnType<typeof allChatLines>>;
    journal: Awaited<ReturnType<typeof allJournalSentences>>;
    excluded: Set<string>;
    learnedBefore: Set<string>;
  } | null>(null);

  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const lexicon = lexiconState.lexicon;
      const [all, sets, chat, ex] = await Promise.all([
        learnerService.allCards(),
        learnerService.wordSets(now),
        allChatLines(db, scenariosState.scenarios),
        excludedZh(db),
      ]);
      const journal = await allJournalSentences(db, ex);
      const cards = waterAllCards(all, now, (id) => Boolean(lexicon.byId(id)));
      const index = new ProgressIndex({ cards: all });
      const learnedBefore = new Set(
        cards.filter((c) => index.learned(c.item)).map((c) => c.item.id),
      );
      if (cancelled) return;
      setDue(cards);
      setSources({ knownIds: sets.knownIds, chat, journal, excluded: ex, learnedBefore });
    })();
    return () => {
      cancelled = true;
    };
  }, [lexiconState.status, scenariosState.status]);

  const levels = useMemo(() => {
    if (!due || lexiconState.status !== 'ready') return [];
    const out = new Set<Level>();
    for (const c of due) {
      const l = lexiconState.lexicon.byId(c.item.id)?.level;
      if (l) out.add(l);
    }
    return [...out];
  }, [due, lexiconState]);
  const bank = useSentenceBank(levels);

  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (lexiconState.status !== 'ready' || !due || !sources || bank.status === 'loading')
    return <p>Loading…</p>;
  const lexicon = lexiconState.lexicon;
  const bankSentences = bank.status === 'ready' ? bank.sentences : [];
  return (
    <WaterSession
      cards={due}
      lexicon={lexicon}
      learnedBefore={sources.learnedBefore}
      clozeFor={(card) => {
        const word = lexicon.byId(card.item.id);
        if (!word) return null;
        const source = selectClozeSource(word, {
          lexicon,
          knownIds: sources.knownIds,
          learnerLevel: level,
          journalSentences: sources.journal,
          chatLines: sources.chat,
          bankSentences,
          excludeZh: sources.excluded,
        });
        return source ? { card, word, exerciseKind: kindForRung(card.clozeRung), source } : null;
      }}
      onExit={onExit}
    />
  );
}

function WaterSession({
  cards,
  lexicon,
  learnedBefore,
  clozeFor,
  onExit,
}: {
  cards: SkillCard[];
  lexicon: Lexicon;
  learnedBefore: ReadonlySet<string>;
  clozeFor: (card: SkillCard) => SessionItem | null;
  onExit: () => void;
}) {
  const { script } = useReadingSettings();
  const [inputMode, setInputMode] = useAnswerInputMode();
  const [seed] = useState(() => newSessionSeed('water'));
  const [entries, setEntries] = useState<Entry[]>(() =>
    planWaterAll(cards, { seed, clozeFor, recent: recentShown() }),
  );
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [correct, setCorrect] = useState(0);
  const watered = useRef(new Set<string>());
  // the last answer being written (the summary waits for it)
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const requeued = useRef(new Set<Entry>());
  const [last, setLast] = useState<{
    undo: () => Promise<void>;
    entries: Entry[];
    index: number;
    correct: number;
  } | null>(null);
  const [summary, setSummary] = useState<{ words: number; perked: number } | null>(null);
  // a few listening exercises for words that already have a practised listening card
  const clips = useListeningClips();
  const listeningOn = useListeningEnabled();
  const [slots, setSlots] = useState<Map<number, PlanItem>>(new Map());
  const [doneSlots, setDoneSlots] = useState<Set<number>>(new Set());
  const [slotCardIds, setSlotCardIds] = useState<Set<string>>(new Set());
  const words = useMemo(() => new Set(cards.map((c) => c.item.id)), [cards]);

  useEffect(() => {
    logSessionOrder('water', seed, entries.length, 0);
    // built once per session
  }, [seed]);

  useEffect(() => {
    if (!listeningOn || !clips.ready) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const listening = await ensureListeningCards(clips.hasClip, now);
      const practised = listening.filter((c) => isDueListening(c, now) && words.has(c.item.id));
      const n = Math.min(practised.length, Math.round(entries.length * LISTENING_CONFIG.mixShare));
      if (n <= 0) return;
      const plan = planListenSession({
        lexicon,
        dueListening: practised,
        newWordIds: [],
        hasClip: clips.hasClip,
        sentences: [],
        size: n,
        seed,
      });
      const placed = placeExtras(entries, plan, describeEntry, describePlanItem);
      if (cancelled) return;
      setSlotCardIds(new Set(listening.map((c) => c.item.id)));
      setSlots(placed);
    })();
    return () => {
      cancelled = true;
    };
    // built once per session (an "Again" re-queue changes the queue, not the session)
  }, [seed, listeningOn, clips.ready]);

  const entry = entries[index];
  const listenNow = slots.get(index) && !doneSlots.has(index) ? slots.get(index) : undefined;

  // The session is over: count the words watered and the ones that became Learned.
  useEffect(() => {
    if (entry || listenNow || summary) return;
    let cancelled = false;
    void pending.current
      .catch(() => undefined)
      .then(() => learnerService.allCards())
      .then((all) => {
        if (cancelled) return;
        const index = new ProgressIndex({ cards: all });
        const perked = [...watered.current].filter(
          (id) => !learnedBefore.has(id) && index.learned({ kind: 'word', id }),
        ).length;
        setSummary({ words: watered.current.size, perked });
      });
    return () => {
      cancelled = true;
    };
  }, [entry, listenNow, summary, learnedBefore]);

  async function answer(e: Entry, evidence: Evidence, ok: boolean, again: boolean) {
    const before = { entries, index, correct };
    watered.current.add(e.card.item.id);
    const recorded = learnerService.recordUndoable(evidence, evidence.at);
    pending.current = recorded;
    const handle = await recorded;
    setLast({ undo: handle.undo, ...before });
    noteShown([
      itemKey(e.card.item),
      ...(lexicon.byId(e.card.item.id) ? [`zh:${lexicon.byId(e.card.item.id)!.headword}`] : []),
    ]);
    if (ok) {
      setPulse((p) => p + 1);
      setCorrect((c) => c + 1);
    }
    // Again (Phase 19/21): a miss comes back once, away from its siblings.
    if (again && !requeued.current.has(e)) {
      requeued.current.add(e);
      const q = requeueAgain(entries, index, (x: Entry) => describeSkillCard(x.card));
      if (q.length !== entries.length) {
        const at = q.findIndex((c, i) => c !== entries[i]);
        const shift = (k: number) => (k >= at ? k + 1 : k);
        setSlots((m) => new Map([...m].map(([k, v]) => [shift(k), v])));
        setDoneSlots((d) => new Set([...d].map(shift)));
        setEntries(q);
      }
    }
  }

  function rate(grade: Grade) {
    if (!entry) return;
    const at = new Date();
    void answer(
      entry,
      { item: entry.card.item, skill: entry.card.skill, kind: `review_${grade}`, at },
      grade === 'good' || grade === 'easy',
      grade === 'again',
    );
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  /** "I think mine is right too": the miss becomes right word (the same as in Cloze). */
  async function mineIsRight(e: Entry) {
    if (!last) return;
    await last.undo();
    setEntries(last.entries);
    requeued.current.delete(e);
    await answer(
      e,
      { item: e.card.item, skill: e.card.skill, kind: 'cloze_correct_hint', at: new Date() },
      true,
      false,
    );
  }

  /** Phase 20 Nope: the word leaves review, and its other cards leave this session. */
  async function sayNope(e: Entry) {
    await nopeWord(e.card.item, 'not_now');
    setEntries((q) =>
      q.filter(
        (x, i) =>
          i <= index || x.card.item.id !== e.card.item.id || x.card.item.kind !== e.card.item.kind,
      ),
    );
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  async function undo() {
    if (!last) return;
    await last.undo();
    setEntries(last.entries);
    setIndex(last.index);
    setCorrect(last.correct);
    setRevealed(false);
    setAttempt((a) => a + 1);
    setLast(null);
  }

  const total = entries.length;
  return (
    <div className="water-all" data-testid="water-all">
      <button onClick={onExit}>← Back to home</button>
      <h1>💧 Water all</h1>
      <MiniPlant pulse={pulse} grown={correct} />
      {summary ? (
        <div className="water-all-done" data-testid="water-all-done">
          <p className="water-all-summary">
            {summary.words === 0 ? NOTHING_DUE : wateredSummary(summary.words, summary.perked)}
          </p>
          <button className="btn-primary" onClick={onExit}>
            Back to home
          </button>
        </div>
      ) : (
        <>
          <p className="water-all-meta">
            <span data-testid="water-all-counter">
              {Math.min(index + 1, total)} of {total}
            </span>{' '}
            · {wateredWordCount(cards)} words
            {last && (
              <>
                {' '}
                <button
                  type="button"
                  className="link-button"
                  data-testid="water-undo"
                  onClick={() => void undo()}
                >
                  {UNDO}
                </button>
              </>
            )}
          </p>
          {listenNow ? (
            <ListenRunner
              key={`slot-${index}`}
              plan={[listenNow]}
              lexicon={lexicon}
              clips={clips}
              cardIds={slotCardIds}
              requeue={false}
              onFinished={(s) => {
                if (s.correct > 0) setPulse((p) => p + 1);
                setDoneSlots((d) => new Set(d).add(index));
              }}
            />
          ) : entry?.kind === 'cloze' ? (
            <>
              {entry.item.source && (
                <div className="cloze-source-label">{entry.item.source.sourceLabel}</div>
              )}
              <ExerciseView
                key={`${index}:${attempt}`}
                item={entry.item}
                lexicon={lexicon}
                onAnswer={(o) =>
                  void answer(
                    entry,
                    {
                      item: entry.card.item,
                      skill: entry.card.skill,
                      kind: clozeKind(o),
                      at: new Date(),
                    },
                    o !== 'wrong',
                    o === 'wrong',
                  )
                }
                onMineIsRight={() => void mineIsRight(entry)}
                onNext={() => setIndex((i) => i + 1)}
                inputMode={inputMode}
                setInputMode={setInputMode}
                script={script}
              />
            </>
          ) : entry ? (
            <ReviewCard
              key={`${index}:${attempt}`}
              card={entry.card}
              isNew={false}
              script={script}
              word={lexicon.byId(entry.card.item.id)}
              lexicon={lexicon}
              revealed={revealed}
              onReveal={() => setRevealed(true)}
              onRate={rate}
              onNope={() => void sayNope(entry)}
            />
          ) : (
            <p>Loading…</p>
          )}
        </>
      )}
    </div>
  );
}
