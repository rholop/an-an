import { useCallback, useEffect, useRef, useState } from 'react';
import type { Evidence, SkillCard } from '@anan/core';
import {
  blockAt,
  keepDeferred,
  describePlanItem,
  describeSkillCard,
  PROGRESS_CONFIG,
  requeueInBlock,
  reviewBlock,
  sessionKeyAt,
  LISTENING_CONFIG,
  lessonIndex,
  newSessionSeed,
  placeExtras,
  planListenSession,
  inShortStep,
  sessionMeta,
  stepInSitting,
  type PlanItem,
} from '@anan/core';
import { buildReviewSession, reviewSessionCards } from '../lib/review-session.js';
import { useReadingScript } from '../components/AnnotatedInline.js';
import {
  BACKLOG_SPREAD,
  blockHeader,
  comeBackNextTime,
  dueNewLine,
  learnedTodayLine,
  waitingForNextSession,
  NOTHING_DUE,
  RELOAD,
  REVIEW_EARLY,
  sessionLine,
  UNDO,
  waitingForWordList,
  waitingSiblings,
} from '../lib/labels.js';
import { NopeToast } from '../components/Nope.js';
import { nopeWord, wakeSnoozed } from '../lib/nope.js';
import { getLedgerNow, useLedger } from '../lib/ledger.js';
import { useSaveWhenDone } from '../lib/save-progress.js';
import { noteConfusion, useConfusables } from '../lib/confusables.js';
import { ReviewCard, type Grade, type RateExtra } from './ReviewCard.js';
import type { NopeChoice } from '@anan/core';
import type { NopeHandle } from '../lib/learner-service.js';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import { ensureListeningCards, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { ListenPage, ListenRunner } from './ListenPage.js';
import { db, learnerService } from '../db/instance.js';
import { fixSession, takeBacklogNotice } from '../lib/calm-review.js';
import { markStudyDirty } from '../lib/study-dirty.js';
import { getReviewSettings } from '../lib/review-settings.js';
import { getStudyBooks, getStudyFocusNow } from '../lib/study.js';
import { ensureFaceCards } from '../lib/face-cards.js';
import { ensureTutorCards } from '../lib/tutoring/introduce.js';
import { DueIcon, EmptySprout } from '../components/PlantIcons.js';
import { reloadLexicon, useLexicon } from '../lib/useLexicon.js';
import { InfoTip } from '../components/InfoTip.js';
import './ReviewPage.css';

export { ReviewCard, type Grade, type RateExtra } from './ReviewCard.js';

/** Phase 27: words answered in a sitting whose every answered card left its short learning step. */
function wordsOutOfStep(answered: ReadonlyMap<string, SkillCard>): number {
  const byWord = new Map<string, boolean>();
  for (const c of answered.values()) {
    if (c.item.kind !== 'word') continue;
    byWord.set(c.item.id, (byWord.get(c.item.id) ?? true) && !inShortStep(c));
  }
  return [...byWord.values()].filter(Boolean).length;
}

/** `focusCards` (Phase 6 garden, Phase 21 lesson session): review exactly these Due cards (and
 * `freshCards`, New ones) instead of the due queue. `reviewAll` (Phase 22 Home "Review all"): every
 * card due now up to the daily cap, no new words. `keepEvery`: a sibling the gap would hold back
 * goes at the end instead, so the session is exactly the count on the button that opened it. */
export function ReviewPage({
  focusCards,
  freshCards,
  onExit,
  exitLabel = '← Back to garden',
  title,
  lesson,
  reviewAll = false,
  reviewEarly = false,
  keepEvery = reviewAll || reviewEarly,
}: {
  focusCards?: SkillCard[];
  freshCards?: SkillCard[];
  onExit?: () => void;
  exitLabel?: string;
  title?: string;
  /** Phase 25: the lesson these cards are studied in (its meaning of a word is shown). */
  lesson?: { bookId: string; n: number };
  reviewAll?: boolean;
  /** Phase 29 Part B.5: the one Review early (Home, Garden and Review all open this). */
  reviewEarly?: boolean;
  keepEvery?: boolean;
} = {}) {
  const lexiconState = useLexicon();
  const script = useReadingScript();
  const confusables = useConfusables(lexiconState.status === 'ready' ? lexiconState.lexicon : null);
  const [queue, setQueue] = useState<SkillCard[] | null>(null);
  // Phase 21: which session cards are New (never answered), so the header says "N due · M new".
  const [freshSet, setFreshSet] = useState<Set<SkillCard>>(new Set());
  // Cards the shared order left for later (sibling gap), so "Nothing due" never hides them.
  const [deferred, setDeferred] = useState(0);
  // Phase 21 Part G: Undo for the last answer.
  const [lastAnswer, setLastAnswer] = useState<{
    undo: () => Promise<void>;
    prevQueue: SkillCard[];
    prevIndex: number;
    prevSlots: Map<number, PlanItem>;
    prevDone: Set<number>;
    prevAnswered: Map<string, SkillCard>;
    prevRepeats: Set<SkillCard>;
  } | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // Phase 28: the end of a session pushes progress to the server straight away.
  useSaveWhenDone(queue !== null && queue.length > 0 && index >= queue.length);
  // Phase 27: every card answered in this sitting, as it is now (lesson end: "Learned today").
  const [answered, setAnswered] = useState<Map<string, SkillCard>>(new Map());
  // Phase 29: the same numbers as Home (the ledger), live.
  const ledgerNow = useLedger();
  // Phase 23: between sessions, "Review early" opens the next session's cards here.
  const [early, setEarly] = useState(reviewEarly);
  // Phase 29 Part B.5: Again repeats in this sitting ("+2 again" in the header).
  const [repeats, setRepeats] = useState<Set<SkillCard>>(new Set());
  // Phase 15: a "Listen" session, and ~20% listening exercises mixed in once an item has a listening card.
  const clips = useListeningClips();
  const listeningOn = useListeningEnabled();
  const [listening, setListening] = useState(false);
  const [slots, setSlots] = useState<Map<number, PlanItem>>(new Map());
  const [doneSlots, setDoneSlots] = useState<Set<number>>(new Set());
  const [slotCardIds, setSlotCardIds] = useState<Set<string>>(new Set());
  const [seed, setSeed] = useState<string>('');
  // Phase 43: the session's new-word note, the cards waiting for the next session, the one-time
  // backlog note, and Again counts in this sitting (the third puts a card aside).
  const [capNote, setCapNote] = useState<{ waiting: number; next: 'morning' | 'evening'; newReason?: string } | null>(null);
  const [backlogNote, setBacklogNote] = useState(false);
  const [agains, setAgains] = useState<Map<string, number>>(new Map());
  const [parked, setParked] = useState<string | null>(null);
  const [nope, setNope] = useState<{
    handle: NopeHandle;
    item: SkillCard['item'];
    word: string;
    prevQueue: SkillCard[];
    prevIndex: number;
  } | null>(null);

  const loadQueue = useCallback(async () => {
    const now = new Date();
    // Phase 14: with the study order on (and not a custom focus list) a few NEW items from the
    // active step lead the session and due cards are ordered textbook-first (never dropped).
    // Phase 19: the order itself (siblings apart, seeded shuffle, directions mixed) is the shared one.
    // Phase 20: at most the daily cap per day (study order first, then the most likely forgotten);
    // no new cards in a backlog, half while one builds. Removed cards are never due.
    const focus = focusCards ? undefined : await getStudyFocusNow(now);
    let due: SkillCard[];
    let fresh: SkillCard[] = [];
    let tutorIds: ReadonlySet<string> = new Set();
    if (focusCards) {
      due = focusCards.filter((c) => !c.flags.excluded && !c.flags.snoozed);
      fresh = (freshCards ?? []).filter((c) => !c.flags.excluded && !c.flags.snoozed);
      setCapNote(null);
    } else {
      // Phase 23: the cards of this review session (morning / evening), or the next one's when
      // "Review early" was asked for between sessions.
      await ensureFaceCards(now).catch(() => 0);
      // Tutoring words' cards still missing (Meaning, then each face once the one before is released).
      await ensureTutorCards(now).catch(() => 0);
      const ledger = await getLedgerNow(now);
      const { status } = ledger;
      tutorIds = ledger.tutorWordIds();
      // Phase 43: the ledger plans the session (at most the ceiling, the day's new cards, faces in
      // order); before its first answer, study-order words with no card may fill the rest of its share.
      const view = ledger.session(early ? { early: true } : {});
      // Between sessions nothing is in a session (new words included) unless Review early was asked for.
      const closed = view.started || (!early && status.session === 'between');
      const newItems = closed ? [] : ledger.pickNew('review', { general: false }).items.filter((i) => !ledger.hasCard(i));
      const picked = reviewSessionCards({ session: view, newItems, now });
      due = picked.due;
      fresh = picked.fresh;
      const nextName = status.session === 'morning' ? 'evening' : status.session === 'evening' ? 'morning' : status.nextSession.name;
      setCapNote(
        view.waiting > 0 || status.newMessage
          ? { waiting: view.waiting, next: nextName, ...(status.newMessage ? { newReason: status.newMessage } : {}) }
          : null,
      );
      if (view.cards.length > 0 && (await takeBacklogNotice(db).catch(() => false))) setBacklogNote(true);
    }
    const sessionSeed = newSessionSeed('review');
    const ordered = buildReviewSession({
      due,
      fresh,
      ...(focus ? { focus } : {}),
      lessonIdx: lessonIndex(getStudyBooks()),
      tutorWordIds: tutorIds,
      seed: sessionSeed,
      recent: recentShown(now),
    });
    const next = keepEvery ? keepDeferred(ordered) : ordered;
    setAgains(new Map());
    setParked(null);
    logSessionOrder('review', sessionSeed, next.length, sessionMeta(next)?.deferred.length ?? 0);
    setSeed(sessionSeed);
    setFreshSet(new Set(fresh));
    setRepeats(new Set());
    setDeferred(sessionMeta(next)?.deferred.length ?? 0);
    setQueue(next);
    setIndex(0);
    setRevealed(false);
    setLastAnswer(null);
  }, [focusCards, freshCards, reviewAll, keepEvery, early]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Phase 20: "Not now" words whose level or lesson became active come back (from the next session).
  useEffect(() => {
    if (lexiconState.status === 'ready') void wakeSnoozed(lexiconState.lexicon).catch(() => 0);
  }, [lexiconState.status]);

  useEffect(() => {
    if (focusCards || !queue || !listeningOn || !clips.ready || lexiconState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const cards = await ensureListeningCards(clips.hasClip, now);
      // Phase 29 Part B.2: listening is its own queue (the ledger's, this session's window).
      const practiced = (await getLedgerNow(now)).practice('listening').due;
      const n = Math.min(practiced.length, Math.round(queue.length * LISTENING_CONFIG.mixShare));
      if (n <= 0) return;
      const plan = planListenSession({
        lexicon: lexiconState.lexicon,
        dueListening: practiced,
        newWordIds: [],
        hasClip: clips.hasClip,
        sentences: [],
        size: n,
        newAllowed: 0,
      });
      // spread over the session, never first, and never within the gap of a card on the same word
      const next = placeExtras(queue, plan, describeSkillCard, describePlanItem);
      if (cancelled) return;
      setSlotCardIds(new Set(cards.map((c) => c.item.id)));
      setDoneSlots(new Set());
      setSlots(next);
    })();
    return () => {
      cancelled = true;
    };
    // built once per session (an "Again" re-queue changes the queue, not the session)
  }, [seed, listeningOn, clips.ready]);

  // Phase 38: a card the loaded word list can't show is skipped (the ledger holds such cards; this
  // covers a list given by the garden or a lesson). It comes back once the word list has its word.
  const lexReady = lexiconState.status === 'ready' ? lexiconState.lexicon : undefined;
  const atCard = queue?.[index];
  const atResolves =
    !atCard || !lexReady || (atCard.item.kind === 'word' ? lexReady.byId(atCard.item.id) : lexReady.grammarItemById(atCard.item.id)) !== undefined;
  useEffect(() => {
    if (!atResolves) setIndex((i) => i + 1);
  }, [atResolves, atCard]);
  // Held cards whose word just arrived (a new word list, "Reload", a synced custom word) join the
  // session: it is rebuilt once the ledger can show them.
  const heldNow = ledgerNow?.unresolved().length;
  const heldBefore = useRef(heldNow);
  useEffect(() => {
    const before = heldBefore.current;
    heldBefore.current = heldNow;
    if (before !== undefined && heldNow !== undefined && heldNow < before) void loadQueue();
  }, [heldNow, loadQueue]);

  if (lexiconState.status === 'loading' || queue === null) return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;

  const lexicon = lexiconState.lexicon;
  const current = atResolves ? queue[index] : undefined;
  const heldCards = heldNow ?? 0;
  const pendingSlot = slots.get(index);
  const listenNow = pendingSlot && !doneSlots.has(index) ? pendingSlot : undefined;

  if (listening)
    return <ListenPage onExit={() => setListening(false)} exitLabel="← Back to review" />;

  /** Phase 20: one tap takes the whole word out of review (all its cards in this session too). */
  async function sayNope(choice: NopeChoice = 'not_now') {
    if (!current || !queue) return;
    const item = current.item;
    const w = item.kind === 'word' ? lexicon.byId(item.id) : undefined;
    const prevQueue = queue;
    const prevIndex = index;
    const handle = await nopeWord(item, choice);
    const same = (c: SkillCard) => c.item.kind === item.kind && c.item.id === item.id;
    setQueue(prevQueue.filter((c, i) => i < prevIndex || !same(c)));
    setRevealed(false);
    setNope({ handle, item, word: w?.headword ?? item.id, prevQueue, prevIndex });
  }

  async function undoNope() {
    if (!nope) return;
    await nope.handle.undo();
    setQueue(nope.prevQueue);
    setIndex(nope.prevIndex);
    setRevealed(false);
    setNope(null);
  }

  async function changeNope(choice: NopeChoice) {
    if (!nope) return;
    await nope.handle.undo();
    const handle = await nopeWord(nope.item, choice);
    setNope({ ...nope, handle });
  }

  async function rate(grade: Grade, extra: RateExtra) {
    if (!current || !queue) return;
    setNope(null);
    const at = new Date();
    // Phase 43 Part C.1: the first answer fixes the session (nothing new joins it afterwards).
    if (!focusCards) {
      const ledger = await getLedgerNow(at);
      if (await fixSession(db, ledger, early ? { early: true } : {}).catch(() => false)) markStudyDirty();
    }
    const evidence: Evidence = {
      item: current.item,
      skill: current.skill,
      kind: `review_${grade}`,
      at,
      context: {
        source: 'review',
        face: extra.face,
        sessionKey: sessionKeyAt(at, await getReviewSettings()),
        ...(extra.pickedId ? { pickedId: extra.pickedId } : {}),
      },
    };
    if (extra.pickedId) noteConfusion(confusables, current.item.id, extra.pickedId);
    const before = { prevQueue: queue, prevIndex: index, prevSlots: slots, prevDone: doneSlots, prevAnswered: answered, prevRepeats: repeats };
    const handle = await learnerService.recordUndoable(evidence, evidence.at);
    setLastAnswer({ undo: handle.undo, ...before });
    // Phase 19: answered cards count as "just shown" for the next session's sibling gap.
    const w = current.item.kind === 'word' ? lexicon.byId(current.item.id) : undefined;
    noteShown([`${current.item.kind}:${current.item.id}`, ...(w ? [`zh:${w.headword}`] : [])]);
    if (handle.card) setAnswered((m) => new Map(m).set(`${current.item.kind}:${current.item.id}|${current.skill}`, handle.card!));
    // Phase 27 / Phase 43 Part E: a card still in a short learning step comes back at the end of its
    // block until FSRS moves it out of the step; the third Again in this sitting puts it aside for the
    // next session.
    const cardKey = `${current.item.kind}:${current.item.id}|${current.skill}`;
    const againCount = (agains.get(cardKey) ?? 0) + (grade === 'again' ? 1 : 0);
    if (grade === 'again') setAgains((m) => new Map(m).set(cardKey, againCount));
    const putAside = grade === 'again' && againCount >= PROGRESS_CONFIG.againsBeforePark;
    if (putAside) {
      const w = current.item.kind === 'word' ? lexicon.byId(current.item.id) : undefined;
      setParked(w?.headword ?? current.item.id);
    }
    if (!putAside && stepInSitting(handle.card, evidence.at) && queue) {
      const q = requeueInBlock(queue, index, reviewBlock, handle.card!);
      if (q.length !== queue.length) {
        // Listening slots after the inserted card move down one with the cards around them.
        const at = q.lastIndexOf(handle.card!);
        const shift = (k: number) => (k >= at ? k + 1 : k);
        setSlots((m) => new Map([...m].map(([k, v]) => [shift(k), v])));
        setDoneSlots((d) => new Set([...d].map(shift)));
        setRepeats((r) => new Set(r).add(handle.card!));
        setQueue(q);
      }
    }
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  /** Phase 21: Undo the last answer (the card, its points and an Again re-queue all go back). */
  async function undoLast() {
    if (!lastAnswer) return;
    await lastAnswer.undo();
    setQueue(lastAnswer.prevQueue);
    setIndex(lastAnswer.prevIndex);
    setSlots(lastAnswer.prevSlots);
    setDoneSlots(lastAnswer.prevDone);
    setAnswered(lastAnswer.prevAnswered);
    setRepeats(lastAnswer.prevRepeats);
    setRevealed(true);
    setLastAnswer(null);
  }

  const rest = queue.slice(index);
  const newLeft = rest.filter((c) => freshSet.has(c)).length;
  const againLeft = rest.filter((c) => repeats.has(c)).length;
  const dueLeft = rest.length - newLeft - againLeft;

  return (
    <div className="review-page">
      {onExit && <button onClick={onExit}>{exitLabel}</button>}
      <h1>{title ?? (focusCards ? 'Water these words' : 'Review')}</h1>
      {/* Phase 30: status, counts and Undo share one compact line; the cap note is a tip icon */}
      <div className="review-statusline">
        {ledgerNow && !focusCards && (
          <span className="review-status" data-testid="review-status">
            <DueIcon /> {sessionLine(ledgerNow.status)}
          </span>
        )}
        <span className="review-meta" data-testid="review-counts">
          {dueNewLine(dueLeft, newLeft, againLeft)}
        </span>
        {capNote?.newReason && (
          <InfoTip label="About new words" testId="review-cap-note">
            {capNote.newReason}
          </InfoTip>
        )}
        {lastAnswer && (
          <button type="button" className="link-button review-undo" onClick={() => void undoLast()} data-testid="review-undo">
            {UNDO} last answer
          </button>
        )}
      </div>

      {current && !listenNow && (() => {
        const b = blockAt(queue, index, reviewBlock);
        return b ? (
          <p className="review-block" data-testid="review-block">
            {blockHeader(b.block, b.left)}
          </p>
        ) : null;
      })()}
      {capNote && capNote.waiting > 0 && (
        <p className="review-settings-muted" data-testid="review-waiting">
          {waitingForNextSession(capNote.waiting, capNote.next)}
        </p>
      )}
      {backlogNote && ledgerNow && (
        <p className="review-settings-muted" data-testid="review-backlog-note">
          {BACKLOG_SPREAD(ledgerNow.status.sessionCards)}
        </p>
      )}
      {parked && (
        <p className="review-settings-muted" data-testid="review-parked">
          {comeBackNextTime(parked)}
        </p>
      )}

      {heldCards > 0 && (
        <p className="review-settings-muted" data-testid="review-waiting-word-list">
          {waitingForWordList(heldCards)} ·{' '}
          <button
            type="button"
            className="link-button"
            data-testid="review-reload-word-list"
            onClick={() => void reloadLexicon()}
          >
            {RELOAD}
          </button>
        </p>
      )}

      {nope && (
        <NopeToast
          word={nope.word}
          choice={nope.handle.choice}
          onUndo={() => void undoNope()}
          onChange={(c) => void changeNope(c)}
          onClose={() => setNope(null)}
        />
      )}

      {listeningOn && clips.ready && !focusCards && (
        <button onClick={() => setListening(true)} data-testid="listen-session-btn">
          🎧 Listen session
        </button>
      )}

      {listenNow ? (
        <ListenRunner
          key={`slot-${index}`}
          plan={[listenNow]}
          lexicon={lexicon}
          clips={clips}
          cardIds={slotCardIds}
          onFinished={() => setDoneSlots((d) => new Set(d).add(index))}
        />
      ) : !atResolves ? null : !current ? (
        <div className="review-done" data-testid="review-done">
          <EmptySprout />
          {lesson && answered.size > 0 && (
            <p data-testid="learned-today">{learnedTodayLine(wordsOutOfStep(answered))}</p>
          )}
          {deferred > 0 ? (
            <p>
              {waitingSiblings(deferred)}{' '}
              <button type="button" onClick={() => void loadQueue()}>
                Check again
              </button>
            </p>
          ) : !focusCards && !early && ledgerNow && ledgerNow.status.nextSession.count > 0 ? (
            <p>
              {NOTHING_DUE}{' '}
              <button type="button" className="link-button" onClick={() => setEarly(true)} data-testid="review-early">
                {REVIEW_EARLY}
              </button>
            </p>
          ) : (
            <p>{NOTHING_DUE}</p>
          )}
        </div>
      ) : (
        <ReviewCard
          key={`${index}:${current.item.kind}:${current.item.id}:${current.skill}`}
          card={current}
          isNew={freshSet.has(current)}
          script={script}
          word={current.item.kind === 'word' ? lexicon.byId(current.item.id) : undefined}
          grammar={current.item.kind === 'grammar' ? lexicon.grammarItemById(current.item.id) : undefined}
          lexicon={lexicon}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onRate={rate}
          onNope={() => void sayNope()}
          confusables={confusables}
          {...(lesson ? { glossLesson: lesson } : {})}
          devPosition={import.meta.env.DEV ? `#${index + 1} of ${queue.length} · seed ${seed}` : undefined}
        />
      )}
    </div>
  );
}

