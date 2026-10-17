// Phase 45 (owner, 2026-10-17: "Why can't I review the lesson / tutoring lesson vocabulary?"):
// practise a lesson's or a tutoring class's words any time, also between sessions and after the
// session is done. The Review card, only the faces each word already has (`ledger.practiceCards`),
// in blocks, weakest first, 20 cards a round. A card's first answer of the day counts as its review
// ("counted ✓"); later answers that day are practice only (an Again puts it first next session).
import { useCallback, useEffect, useState } from 'react';
import {
  blockAt,
  practiceAnswerKind,
  PRACTICE_ROUND_SIZE,
  requeueInBlock,
  reviewBlock,
  sessionKeyAt,
  type Evidence,
  type ItemRef,
  type NopeChoice,
  type SkillCard,
} from '@anan/core';
import { useReadingScript } from '../components/AnnotatedInline.js';
import { NopeToast } from '../components/Nope.js';
import { EmptySprout } from '../components/PlantIcons.js';
import { learnerService } from '../db/instance.js';
import { noteConfusion, useConfusables } from '../lib/confusables.js';
import {
  blockHeader,
  DONE,
  PRACTICE_COUNTED,
  PRACTICE_NOTE,
  PRACTISE_ANOTHER_ROUND,
  practiceRoundDone,
  practiseTheseWords,
  startInNextSessions,
  UNDO,
} from '../lib/labels.js';
import { getLedgerNow, useLedger } from '../lib/ledger.js';
import type { NopeHandle } from '../lib/learner-service.js';
import { nopeWord } from '../lib/nope.js';
import { getReviewSettings } from '../lib/review-settings.js';
import { useSaveWhenDone } from '../lib/save-progress.js';
import { useLexicon } from '../lib/useLexicon.js';
import { ReviewCard, type Grade, type RateExtra } from './ReviewCard.js';
import './ReviewPage.css';

const cardKey = (c: Pick<SkillCard, 'item' | 'skill'>) => `${c.item.kind}:${c.item.id}|${c.skill}`;

/** One round: cards not practised in this sitting first, at most `PRACTICE_ROUND_SIZE`, in the
 * ledger's order (blocks, weakest first). */
export function practiceRound(all: readonly SkillCard[], practised: ReadonlySet<string>): SkillCard[] {
  const fresh = all.filter((c) => !practised.has(cardKey(c)));
  const pick = new Set([...fresh, ...all.filter((c) => practised.has(cardKey(c)))].slice(0, PRACTICE_ROUND_SIZE));
  return all.filter((c) => pick.has(c));
}

export function PracticePage({
  items,
  title,
  onExit,
  exitLabel,
  lesson,
}: {
  /** The lesson's or class's items (only words are practised). */
  items: readonly ItemRef[];
  title: string;
  onExit: () => void;
  exitLabel: string;
  /** The lesson these words are studied in (its meaning of a word is shown). */
  lesson?: { bookId: string; n: number };
}) {
  const lexiconState = useLexicon();
  const script = useReadingScript();
  const confusables = useConfusables(lexiconState.status === 'ready' ? lexiconState.lexicon : null);
  const [queue, setQueue] = useState<SkillCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // cards answered in this sitting (the next round starts with the others), and cards whose answer
  // counted today (a guard while the ledger rebuilds)
  const [practised, setPractised] = useState<Set<string>>(new Set());
  const [counted, setCounted] = useState<Set<string>>(new Set());
  const [againOnce, setAgainOnce] = useState<Set<string>>(new Set());
  const [lastCounted, setLastCounted] = useState(false);
  const [answeredInRound, setAnsweredInRound] = useState(0);
  const [lastAnswer, setLastAnswer] = useState<{
    undo: () => Promise<void>;
    prev: { queue: SkillCard[]; index: number; practised: Set<string>; counted: Set<string>; againOnce: Set<string>; answered: number };
  } | null>(null);
  const [nope, setNope] = useState<{ handle: NopeHandle; item: ItemRef; word: string; prevQueue: SkillCard[]; prevIndex: number } | null>(null);
  useSaveWhenDone(queue !== null && queue.length > 0 && index >= queue.length);

  const loadRound = useCallback(
    async (done: ReadonlySet<string>) => {
      const ledger = await getLedgerNow(new Date());
      setQueue(practiceRound(ledger.practiceCards(items), done));
      setIndex(0);
      setRevealed(false);
      setAgainOnce(new Set());
      setAnsweredInRound(0);
      setLastAnswer(null);
      setLastCounted(false);
    },
    [items],
  );

  useEffect(() => {
    void loadRound(new Set());
    // built once per list (a new round is asked for)
  }, [loadRound]);

  if (lexiconState.status === 'loading' || queue === null) return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  const lexicon = lexiconState.lexicon;
  const current = queue[index];

  async function rate(grade: Grade, extra: RateExtra) {
    if (!current || !queue) return;
    setNope(null);
    const at = new Date();
    const k = cardKey(current);
    const ledger = await getLedgerNow(at);
    const counts = !counted.has(k) && ledger.practiceCounts(current);
    const evidence: Evidence = {
      item: current.item,
      skill: current.skill,
      kind: practiceAnswerKind(grade, counts),
      at,
      context: {
        source: 'review',
        practice: true,
        face: extra.face,
        sessionKey: sessionKeyAt(at, await getReviewSettings()),
        ...(extra.pickedId ? { pickedId: extra.pickedId } : {}),
      },
    };
    if (extra.pickedId) noteConfusion(confusables, current.item.id, extra.pickedId);
    const prev = { queue, index, practised, counted, againOnce, answered: answeredInRound };
    const handle = await learnerService.recordUndoable(evidence, at);
    setLastAnswer({ undo: handle.undo, prev });
    setLastCounted(counts);
    setPractised((s) => new Set(s).add(k));
    if (counts) setCounted((s) => new Set(s).add(k));
    setAnsweredInRound((n) => n + 1);
    // Again comes back once at the end of its block, so the learner sees it again this round.
    if (grade === 'again' && !againOnce.has(k)) {
      setAgainOnce((s) => new Set(s).add(k));
      setQueue(requeueInBlock(queue, index, reviewBlock, handle.card ?? current));
    }
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  async function undoLast() {
    if (!lastAnswer) return;
    await lastAnswer.undo();
    const p = lastAnswer.prev;
    setQueue(p.queue);
    setIndex(p.index);
    setPractised(p.practised);
    setCounted(p.counted);
    setAgainOnce(p.againOnce);
    setAnsweredInRound(p.answered);
    setRevealed(true);
    setLastCounted(false);
    setLastAnswer(null);
  }

  async function sayNope(choice: NopeChoice = 'not_now') {
    if (!current || !queue) return;
    const item = current.item;
    const w = item.kind === 'word' ? lexicon.byId(item.id) : undefined;
    const handle = await nopeWord(item, choice);
    const same = (c: SkillCard) => c.item.kind === item.kind && c.item.id === item.id;
    setQueue(queue.filter((c, i) => i < index || !same(c)));
    setRevealed(false);
    setNope({ handle, item, word: w?.headword ?? item.id, prevQueue: queue, prevIndex: index });
  }

  const block = current ? blockAt(queue, index, reviewBlock) : undefined;
  return (
    <div className="review-page" data-testid="practice-page">
      <button type="button" onClick={onExit}>
        {exitLabel}
      </button>
      <h1>{title}</h1>
      <div className="review-statusline">
        <span className="review-meta" data-testid="practice-counts">
          {Math.max(0, queue.length - index)} left
        </span>
        {lastAnswer && lastCounted && (
          <span className="review-meta" data-testid="practice-counted">
            {PRACTICE_COUNTED}
          </span>
        )}
        {lastAnswer && (
          <button type="button" className="link-button review-undo" onClick={() => void undoLast()} data-testid="practice-undo">
            {UNDO} last answer
          </button>
        )}
      </div>
      <p className="review-settings-muted">{PRACTICE_NOTE}</p>
      {block && (
        <p className="review-block" data-testid="review-block">
          {blockHeader(block.block, block.left)}
        </p>
      )}
      {nope && (
        <NopeToast
          word={nope.word}
          choice={nope.handle.choice}
          onUndo={() =>
            void (async () => {
              await nope.handle.undo();
              setQueue(nope.prevQueue);
              setIndex(nope.prevIndex);
              setNope(null);
            })()
          }
          onChange={(c) =>
            void (async () => {
              await nope.handle.undo();
              setNope({ ...nope, handle: await nopeWord(nope.item, c) });
            })()
          }
          onClose={() => setNope(null)}
        />
      )}
      {current ? (
        <ReviewCard
          key={`${index}:${cardKey(current)}`}
          card={current}
          isNew={false}
          script={script}
          word={current.item.kind === 'word' ? lexicon.byId(current.item.id) : undefined}
          lexicon={lexicon}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onRate={(g, x) => void rate(g, x)}
          onNope={() => void sayNope()}
          confusables={confusables}
          {...(lesson ? { glossLesson: lesson } : {})}
        />
      ) : (
        <div className="review-done" data-testid="practice-done">
          <EmptySprout />
          <p>{practiceRoundDone(answeredInRound)}</p>
          <p>
            <button type="button" className="btn-primary" onClick={() => void loadRound(practised)} data-testid="practice-again-round">
              {PRACTISE_ANOTHER_ROUND}
            </button>{' '}
            <button type="button" onClick={onExit} data-testid="practice-finish">
              {DONE}
            </button>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * "Practise these words (N)" (N = the words with a card to practise) and "4 words from this lesson
 * start in the next sessions" (words with no card yet, under the day's new-word limit). Nothing when
 * there is neither.
 */
export function PractiseEntry({
  items,
  where,
  onStart,
  primary = false,
}: {
  items: readonly ItemRef[];
  where: 'lesson' | 'class';
  onStart: () => void;
  primary?: boolean;
}) {
  const ledger = useLedger();
  if (!ledger) return null;
  const n = ledger.practiceWordCount(items);
  const waiting = ledger.notStartedWords(items).length;
  if (n === 0 && waiting === 0) return null;
  return (
    <span className="practise-entry">
      {n > 0 && (
        <button type="button" className={primary ? 'btn-primary' : undefined} onClick={onStart} data-testid="practise-words">
          {practiseTheseWords(n)}
        </button>
      )}
      {waiting > 0 && (
        <small className="textbook-muted" data-testid="practise-waiting">
          {' '}
          {startInNextSessions(waiting, where)}
        </small>
      )}
    </span>
  );
}
