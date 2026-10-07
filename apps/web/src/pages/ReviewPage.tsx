import { useCallback, useEffect, useState } from 'react';
import type { Evidence, GrammarItem, Lexicon, SkillCard, Word } from '@anan/core';
import { homeLessonOfTags, lessonBadge, nextLeechTreatment } from '@anan/core';
import {
  describePlanItem,
  describeSkillCard,
  emptyCard,
  LISTENING_CONFIG,
  lessonIndex,
  newSessionSeed,
  placeExtras,
  planListenSession,
  requeueAgain,
  sessionMeta,
  type PlanItem,
} from '@anan/core';
import { buildReviewSession, pickReviewCards } from '../lib/review-session.js';
import { NopeButton, NopeToast } from '../components/Nope.js';
import { nopeWord, wakeSnoozed } from '../lib/nope.js';
import { getReviewSettings } from '../lib/review-settings.js';
import type { NopeChoice } from '@anan/core';
import type { NopeHandle } from '../lib/learner-service.js';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import { ensureListeningCards, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { ListenPage, ListenRunner } from './ListenPage.js';
import { db, learnerService } from '../db/instance.js';
import { getStudyBooks, getStudyFocusNow } from '../lib/study.js';
import { dueForecast, reviewsDoneToday } from '../db/queries.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { useLexicon } from '../lib/useLexicon.js';
import './ReviewPage.css';

/** A card for an item that has no card yet: rating it records the first evidence. */
function newCard(item: SkillCard['item'], now: Date): SkillCard {
  return {
    item,
    skill: 'recognition',
    card: emptyCard(now),
    state: 'unseen',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: now,
  };
}

type Grade = 'again' | 'hard' | 'good' | 'easy';
const GRADES: { grade: Grade; label: string }[] = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
];

/** `focusCards` (Phase 6 garden): review exactly these cards — e.g. a plot's
 * wilting words, which may not be formally due yet — instead of the due queue. */
export function ReviewPage({
  focusCards,
  onExit,
  exitLabel = '← Back to garden',
  title,
}: { focusCards?: SkillCard[]; onExit?: () => void; exitLabel?: string; title?: string } = {}) {
  const lexiconState = useLexicon();
  const [queue, setQueue] = useState<SkillCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [forecast, setForecast] = useState<number[] | null>(null);
  const [totalDue, setTotalDue] = useState(0);
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
      setCapNote(null);
    } else {
      const [all, doneToday, rs] = await Promise.all([
        learnerService.dueCards(now, 5000),
        reviewsDoneToday(db, now),
        getReviewSettings(),
      ]);
      const picked = pickReviewCards({
        due: all,
        doneToday,
        cap: rs.dailyCap,
        ...(focus ? { focus } : {}),
        lessonIdx: lessonIndex(getStudyBooks()),
        now,
      });
      due = picked.due;
      fresh = picked.newItems.map((item) => newCard(item, now));
      setCapNote(
        picked.held > 0 || picked.newReason
          ? { held: picked.held, cap: rs.dailyCap, ...(picked.newReason ? { newReason: picked.newReason } : {}) }
          : null,
      );
    }
    const sessionSeed = newSessionSeed('review');
    const next = buildReviewSession({
      due,
      fresh,
      ...(focus ? { focus } : {}),
      lessonIdx: lessonIndex(getStudyBooks()),
      seed: sessionSeed,
      recent: recentShown(now),
    });
    logSessionOrder('review', sessionSeed, next.length, sessionMeta(next)?.deferred.length ?? 0);
    setSeed(sessionSeed);
    setQueue(next);
    setIndex(0);
    setRevealed(false);
    setTotalDue(next.length);
    setForecast(await dueForecast(db, now, 7));
  }, [focusCards]);

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
      const practiced = cards.filter((c) => c.card.reps > 0 && c.card.due <= now);
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
    if (!current) return;
    setNope(null);
    const evidence: Evidence = {
      item: current.item,
      skill: current.skill,
      kind: `review_${grade}`,
      at: new Date(),
    };
    await learnerService.record(evidence, evidence.at);
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
        setTotalDue((n) => n + 1);
      }
    }
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  return (
    <div className="review-page">
      {onExit && <button onClick={onExit}>{exitLabel}</button>}
      <h1>{title ?? (focusCards ? 'Water these words' : 'Review')}</h1>
      <p className="review-meta">
        {Math.max(queue.length - index, 0)} due now (of {totalDue} this session)
        {forecast && <span className="review-forecast"> · next 7 days: {forecast.join(', ')}</span>}
      </p>

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
        <p className="review-done">
          {totalDue === 0 ? 'Nothing due right now.' : 'All done for now — nice work.'}
        </p>
      ) : (
        <ReviewCard
          card={current}
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

function ReviewCard({
  card,
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
  const front = grammar
    ? grammar.pattern
    : card.skill === 'recognition'
      ? (word?.headword ?? '(unknown item)')
      : (word?.glossEn ?? '(unknown item)');
  const back = grammar
    ? grammar.explanationEn
    : card.skill === 'recognition'
      ? `${word?.pinyin ?? ''} · ${word?.zhuyin ?? ''} — ${word?.glossEn ?? ''}`
      : `${word?.headword ?? ''} (${word?.pinyin ?? ''})`;

  return (
    <div className="review-card">
      <div className="review-card-skill">
        {grammar ? 'grammar' : card.skill}
        {devPosition && <span data-testid="dev-session-position"> · {devPosition}</span>}
        {lesson !== undefined && (
          <span className="textbook-badge" lang="zh-Hant">
            {lessonBadge(lesson.n, lesson.bookId)}
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
          <div className="review-card-back">{back}</div>
          {word && <SpeakerButton kind="word" id={word.id} label={word.headword} />}
          {card.leech && word && <LeechBreakdown card={card} word={word} lexicon={lexicon} />}
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
            <button className="review-reveal" onClick={onReveal}>
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
}: {
  card: SkillCard;
  word: Word;
  lexicon: Lexicon;
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
        {word.chars.map((ch, i) => {
          const info = lexicon.charInfo(ch);
          const entry = info.words[0];
          return (
            <div className="leech-char" key={i}>
              <div className="leech-char-glyph">{ch}</div>
              <div className="leech-char-reading">{entry?.pinyin ?? '?'}</div>
              <div className="leech-char-gloss">
                {entry?.glossEn ?? '(not its own lexicon entry)'}
              </div>
            </div>
          );
        })}
      </div>
      {treatment !== 'char_breakdown' && (
        <div className="leech-stub-note">
          ({treatment.replace('_', ' ')} — coming in a later phase)
        </div>
      )}
    </div>
  );
}
