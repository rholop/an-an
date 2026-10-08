import { useCallback, useEffect, useState } from 'react';
import type { Evidence, GrammarItem, Lexicon, SkillCard, Word } from '@anan/core';
import { isDueListening } from '@anan/core';
import { charsInWord, glossFor, homeLessonOfTags, isNewCard, nextLeechTreatment } from '@anan/core';
import {
  keepDeferred,
  describePlanItem,
  describeSkillCard,
  LISTENING_CONFIG,
  lessonIndex,
  newSessionSeed,
  placeExtras,
  planListenSession,
  requeueAgain,
  sessionMeta,
  type PlanItem,
} from '@anan/core';
import { buildReviewSession, newSessionCard, pickReviewCards } from '../lib/review-session.js';
import { AnnotatedInline, useReadingScript } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { dueNewLine, dueNowLine, FORECAST_REST_OF_TODAY, lessonLabel, NOTHING_DUE, UNDO, waitingSiblings } from '../lib/labels.js';
import { readingText } from '../lib/reading.js';
import { NopeButton, NopeToast } from '../components/Nope.js';
import { nopeWord, wakeSnoozed } from '../lib/nope.js';
import { getReviewSettings } from '../lib/review-settings.js';
import { loadReviewStatus, useReviewStatus } from '../lib/review-status.js';
import type { NopeChoice } from '@anan/core';
import type { NopeHandle } from '../lib/learner-service.js';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import { ensureListeningCards, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { ListenPage, ListenRunner } from './ListenPage.js';
import { learnerService } from '../db/instance.js';
import { getStudyBooks, getStudyFocusNow } from '../lib/study.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { DueIcon, EmptySprout } from '../components/PlantIcons.js';
import { useLexicon } from '../lib/useLexicon.js';
import './ReviewPage.css';

export type Grade = 'again' | 'hard' | 'good' | 'easy';
const GRADES: { grade: Grade; label: string }[] = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

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
  reviewAll = false,
  keepEvery = reviewAll,
}: {
  focusCards?: SkillCard[];
  freshCards?: SkillCard[];
  onExit?: () => void;
  exitLabel?: string;
  title?: string;
  reviewAll?: boolean;
  keepEvery?: boolean;
} = {}) {
  const lexiconState = useLexicon();
  const script = useReadingScript();
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
  } | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // Phase 22: the same numbers as Home (core `reviewStatus`), live.
  const reviewState = useReviewStatus();
  // Phase 15: a "Listen" session, and ~20% listening exercises mixed in once an item has a listening card.
  const clips = useListeningClips();
  const listeningOn = useListeningEnabled();
  const [listening, setListening] = useState(false);
  const [slots, setSlots] = useState<Map<number, PlanItem>>(new Map());
  const [doneSlots, setDoneSlots] = useState<Set<number>>(new Set());
  const [slotCardIds, setSlotCardIds] = useState<Set<string>>(new Set());
  const [seed, setSeed] = useState<string>('');
  // Phase 20: the daily cap's effect on this session, and the last Nope (for Undo / Change).
  const [capNote, setCapNote] = useState<{ held: number; cap: number; newReason?: string } | null>(null);
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
    if (focusCards) {
      due = focusCards.filter((c) => !c.flags.excluded && !c.flags.snoozed);
      fresh = (freshCards ?? []).filter((c) => !c.flags.excluded && !c.flags.snoozed);
      setCapNote(null);
    } else {
      const [all, newCards, rs] = await Promise.all([
        learnerService.dueCards(now),
        reviewAll ? Promise.resolve([]) : learnerService.newCards(),
        getReviewSettings(),
      ]);
      // Phase 22: today's distinct reviewed cards, from the one review status.
      const { status } = await loadReviewStatus(now, rs.dailyCap);
      const picked = pickReviewCards({
        due: all,
        newCards,
        doneToday: status.doneToday,
        ...(reviewAll ? { baseNew: 0 } : {}),
        cap: rs.dailyCap,
        ...(focus ? { focus } : {}),
        lessonIdx: lessonIndex(getStudyBooks()),
        now,
      });
      due = picked.due;
      fresh = [...picked.fresh, ...picked.newItems.map((item) => newSessionCard(item, now))];
      setCapNote(
        picked.held > 0 || picked.newReason
          ? { held: picked.held, cap: rs.dailyCap, ...(picked.newReason ? { newReason: picked.newReason } : {}) }
          : null,
      );
    }
    const sessionSeed = newSessionSeed('review');
    const ordered = buildReviewSession({
      due,
      fresh,
      ...(focus ? { focus } : {}),
      lessonIdx: lessonIndex(getStudyBooks()),
      seed: sessionSeed,
      recent: recentShown(now),
    });
    const next = keepEvery ? keepDeferred(ordered) : ordered;
    logSessionOrder('review', sessionSeed, next.length, sessionMeta(next)?.deferred.length ?? 0);
    setSeed(sessionSeed);
    setFreshSet(new Set(fresh.filter((c) => isNewCard(c) || c.state === 'unseen')));
    setDeferred(sessionMeta(next)?.deferred.length ?? 0);
    setQueue(next);
    setIndex(0);
    setRevealed(false);
    setLastAnswer(null);
  }, [focusCards, freshCards, reviewAll, keepEvery]);

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
      const practiced = cards.filter((c) => isDueListening(c, now));
      const n = Math.min(practiced.length, Math.round(queue.length * LISTENING_CONFIG.mixShare));
      if (n <= 0) return;
      const plan = planListenSession({
        lexicon: lexiconState.lexicon,
        dueListening: practiced,
        newWordIds: [],
        hasClip: clips.hasClip,
        sentences: [],
        size: n,
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

  if (lexiconState.status === 'loading' || queue === null) return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;

  const lexicon = lexiconState.lexicon;
  const current = queue[index];
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

  async function rate(grade: Grade) {
    if (!current || !queue) return;
    setNope(null);
    const evidence: Evidence = {
      item: current.item,
      skill: current.skill,
      kind: `review_${grade}`,
      at: new Date(),
    };
    const before = { prevQueue: queue, prevIndex: index, prevSlots: slots, prevDone: doneSlots };
    const handle = await learnerService.recordUndoable(evidence, evidence.at);
    setLastAnswer({ undo: handle.undo, ...before });
    // Phase 19: answered cards count as "just shown" for the next session's sibling gap.
    const w = current.item.kind === 'word' ? lexicon.byId(current.item.id) : undefined;
    noteShown([`${current.item.kind}:${current.item.id}`, ...(w ? [`zh:${w.headword}`] : [])]);
    // Phase 19 rule 6: "Again" comes back later in this session (≥5 cards on, away from siblings).
    if (grade === 'again' && queue) {
      const q = requeueAgain(queue, index, describeSkillCard);
      if (q.length !== queue.length) {
        // Listening slots after the inserted card move down one with the cards around them.
        const at = q.findIndex((c, i) => c !== queue[i]);
        const shift = (k: number) => (k >= at ? k + 1 : k);
        setSlots((m) => new Map([...m].map(([k, v]) => [shift(k), v])));
        setDoneSlots((d) => new Set([...d].map(shift)));
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
    setRevealed(true);
    setLastAnswer(null);
  }

  const rest = queue.slice(index);
  const newLeft = rest.filter((c) => freshSet.has(c)).length;
  const dueLeft = rest.length - newLeft;

  return (
    <div className="review-page">
      {onExit && <button onClick={onExit}>{exitLabel}</button>}
      <h1>{title ?? (focusCards ? 'Water these words' : 'Review')}</h1>
      {reviewState && (
        <p className="review-status" data-testid="review-status">
          <DueIcon /> {dueNowLine(reviewState.status)}
        </p>
      )}
      <p className="review-meta" data-testid="review-counts">
        {dueNewLine(dueLeft, newLeft)}
        {reviewState && (
          <span className="review-forecast" title={`Reviews per day: ${FORECAST_REST_OF_TODAY.toLowerCase()} first (cards due now not included)`}>
            {' '}
            · {FORECAST_REST_OF_TODAY.toLowerCase()}, then next 6 days: {reviewState.forecast.join(', ')}
          </span>
        )}
      </p>

      {lastAnswer && (
        <p className="review-undo">
          <button type="button" onClick={() => void undoLast()} data-testid="review-undo">
            {UNDO} last answer
          </button>
        </p>
      )}

      {capNote && (
        <p className="review-cap-note" data-testid="review-cap-note">
          {capNote.held > 0 &&
            `Today's ${capNote.cap} most important reviews; ${capNote.held} more stay due for later (daily cap, Settings → Review). `}
          {capNote.newReason}
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
      ) : !current ? (
        <div className="review-done" data-testid="review-done">
          <EmptySprout />
          {deferred > 0 ? (
            <p>
              {waitingSiblings(deferred)}{' '}
              <button type="button" onClick={() => void loadQueue()}>
                Check again
              </button>
            </p>
          ) : (
            <p>{NOTHING_DUE}</p>
          )}
        </div>
      ) : (
        <ReviewCard
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
          devPosition={import.meta.env.DEV ? `#${index + 1} of ${queue.length} · seed ${seed}` : undefined}
        />
      )}
    </div>
  );
}

export function ReviewCard({
  card,
  isNew,
  script,
  word,
  grammar,
  lexicon,
  revealed,
  onReveal,
  onRate,
  onNope,
  devPosition,
}: {
  card: SkillCard;
  isNew: boolean;
  script: AnnotationScript;
  word: Word | undefined;
  grammar?: GrammarItem;
  lexicon: Lexicon;
  revealed: boolean;
  onReveal: () => void;
  onRate: (grade: Grade) => void;
  /** Phase 20: take this word out of review. */
  onNope: () => void;
  /** Phase 19 Part C (dev builds): the card's place in the session, to check spacing by eye. */
  devPosition?: string;
}) {
  // Phase 12: grammar patterns are schedulable items too — pattern on the front,
  // the app's own explanation on the back.
  const lesson = grammar ? homeLessonOfTags(grammar.tags ?? []) : word ? homeLessonOfTags(word.tags) : undefined;
  // Phase 21 Part I: one gloss rule (glossFor) and the reading setting's script.
  const gloss = word ? glossFor(word) : '';
  const reading = word ? readingText(word, script) : '';
  const front = grammar
    ? grammar.pattern
    : card.skill === 'recognition'
      ? (word?.headword ?? '(unknown item)')
      : (gloss || '(unknown item)');

  return (
    <div className="review-card">
      <div className="review-card-skill">
        {isNew && <span className="review-new-chip" data-testid="review-new">New · </span>}
        {grammar ? 'grammar' : card.skill}
        {devPosition && <span data-testid="dev-session-position"> · {devPosition}</span>}
        {lesson !== undefined && (
          <span className="textbook-badge" lang="zh-Hant">
            {lessonLabel(lesson.n, lesson.bookId)}
          </span>
        )}
      </div>
      <div
        className="review-card-front"
        lang={grammar || card.skill === 'recognition' ? 'zh-Hant' : undefined}
      >
        {front}
      </div>

      {revealed ? (
        <>
          <div className="review-card-back" data-testid="review-back">
            {grammar ? (
              grammar.explanationEn
            ) : card.skill === 'recognition' ? (
              <>
                {reading} — {gloss}
              </>
            ) : (
              <>
                {/* the answer is shown now, so its words may be looked up */}
                {word && lexicon ? (
                  <span lang="zh-Hant">
                    <AnnotatedInline text={word.headword} lexicon={lexicon} script={script} />
                  </span>
                ) : null}{' '}
                ({reading})
              </>
            )}
          </div>
          {word && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
          {card.leech && word && <LeechBreakdown card={card} word={word} lexicon={lexicon} script={script} />}
          <div className="review-actions">
            <div className="review-buttons">
              {GRADES.map(({ grade, label }) => (
                <button
                  key={grade}
                  className={`review-btn review-btn--${grade}`}
                  onClick={() => onRate(grade)}
                >
                  {label}
                </button>
              ))}
              <NopeButton onNope={onNope} />
            </div>
          </div>
        </>
      ) : (
        <div className="review-actions">
          <div className="review-reveal-row">
            <button className="review-reveal btn-primary" onClick={onReveal}>
              Show answer
            </button>
            <NopeButton onNope={onNope} />
          </div>
        </div>
      )}
    </div>
  );
}

function LeechBreakdown({
  card,
  word,
  lexicon,
  script,
}: {
  card: SkillCard;
  word: Word;
  lexicon: Lexicon;
  script: AnnotationScript;
}) {
  // Phase 2 only actually implements the char_breakdown treatment (shown
  // below, unconditionally, since that's what this panel is); the other
  // three rotation slots are stubs — this note just previews what the
  // rotation would suggest trying next.
  const treatment = nextLeechTreatment({ leechTreatmentsTried: card.leechTreatmentsTried });
  return (
    <div className="leech-panel">
      <div className="leech-title">Leech — character breakdown</div>
      <div className="leech-chars">
        {/* Phase 21: each character's reading IN THIS WORD (MOE), not its first dictionary entry */}
        {charsInWord(word, lexicon).map((c, i) => (
          <div className="leech-char" key={i}>
            <div className="leech-char-glyph">{c.ch}</div>
            <div className="leech-char-reading">{readingText(c, script) || '?'}</div>
            <div className="leech-char-gloss">{c.glossEn ?? '(not its own lexicon entry)'}</div>
          </div>
        ))}
      </div>
      {treatment !== 'char_breakdown' && (
        <div className="leech-stub-note">
          ({treatment.replace('_', ' ')} — coming in a later phase)
        </div>
      )}
    </div>
  );
}
