import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardShortcut } from '../lib/keyboard-shortcuts.js';
import {
  displayLevel,
  isUsableSentence,
  levelIndex,
  lessonIndex,
  maxVisibleLesson,
  pickNewForSession,
  studyRank,
  planListenSession,
  LISTENING_CONFIG,
  type PlanItem,
  type SkillCard,
  buildClozeExercise,
  buildLePlacementExercise,
  buildMainlandVsTaiwanExercise,
  buildMultipleChoiceOptions,
  buildReorderExercise,
  buildMixedSession,
  buildWordBankOptions,
  clozeAnswerEvidence,
  clozePracticeEvidence,
  clozeSessionMeta,
  CLOZE_CONFIG,
  gradeClozeAnswer,
  reviewErrorItem,
  type AnswerKnown,
  type ChoiceOption,
  type ClozeInputMode,
  type ErrorItem,
  type JournalSentenceSource,
  type Lexicon,
  type Level,
  type NaturalPairExercise,
  type SentenceBankEntry,
  type SessionEntry,
  type SessionItem,
} from '@anan/core';
import { currentSession, db, gameService, learnerService } from '../db/instance.js';
import { ReportButton, ReportNotice } from '../components/ReportSheet.js';
import {
  alsoInOtherProfiles,
  excludedZh,
  reportJournalItem,
  reportSource,
  restoreJournalItem,
  restoreSource,
} from '../lib/cloze-reports.js';
import { JournalService } from '../lib/journal-service.js';
import { getProtectedTerms } from '../lib/journal-protected.js';
import { ErrorExerciseView, type ErrorOutcome } from './ErrorExerciseView.js';
import { FetchTutorLLM } from '../lib/tutor-llm.js';
import {
  reconsiderAnswer,
  type ClozeReportReason,
  type ItemAnswer,
  type Reconsidered,
} from '@anan/core';
import { ListenRunner } from './ListenPage.js';
import { NopeButton, NopeToast } from '../components/Nope.js';
import { nopeWord } from '../lib/nope.js';
import { getLedgerNow } from '../lib/ledger.js';
import { useSaveWhenDone } from '../lib/save-progress.js';
import type { NopeHandle } from '../lib/learner-service.js';
import type { NopeChoice } from '@anan/core';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import {
  describePlanItem,
  itemKey,
  newSessionSeed,
  requeueAgain,
  requeueInSitting,
  stepInSitting,
  placeExtras,
  sessionMeta,
  type SessionCard,
  type SessionEntry as OrderedEntry,
} from '@anan/core';

/** Phase 19: a cloze entry's sibling keys (for placing listening extras). */
function describeClozeEntry(e: OrderedEntry): SessionCard {
  return e.kind === 'card'
    ? { keys: [itemKey(e.item.card.item), `zh:${e.item.word.headword}`] }
    : { keys: [`error:${e.error.id}`, ...(e.error.itemRef ? [itemKey(e.error.itemRef)] : [])] };
}
import { ensureListeningCards, useListeningClips, useListeningEnabled } from '../lib/listening.js';
import { SpeakerButton } from '../components/SpeakerButton.js';
import { EmptySprout } from '../components/PlantIcons.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { allChatLines, allJournalSentences } from '../db/queries.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import { useSentenceBank } from '../lib/useSentenceBank.js';
import { tutorBankSentences, useTutorSessions } from '../lib/tutoring/useTutorSessions.js';
import { getStudyBooks, useClassScope, useStudyFocus } from '../lib/study.js';
import { sentenceBookId, sentenceOrdinal, useTextbookSentences } from '../lib/textbook-data.js';
import { onStudyDirty } from '../lib/study-dirty.js';
import { newSessionCard } from '../lib/review-session.js';
import { readingText, useAnswerInputMode, useReadingSettings, type AnswerInputMode } from '../lib/reading.js';
import { AnnotatedInline } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import {
  FEEDBACK_CORRECT,
  FEEDBACK_WRONG_TONE,
  MINE_IS_RIGHT,
  NEXT,
  NOTHING_DUE,
  UNDO,
  AGAIN,
  clozeStartLabel,
  clozeWaitingFixes,
  feedbackWrong,
  LEARN_WORDS_FIRST,
  PRACTICE,
} from '../lib/labels.js';
import { glossFor } from '@anan/core';
import { GrammarRound } from './GrammarStep.js';
import './ClozePage.css';

export type Outcome = 'correct' | 'correct_wrong_tone' | 'wrong';

/** Open another page (App listens for `anan:go`), at a section when `anchor` is given. */
function goTo(route: string, anchor?: string) {
  window.dispatchEvent(new CustomEvent('anan:go', { detail: { route, ...(anchor ? { anchor } : {}) } }));
}

function evidenceKindFor(
  outcome: Outcome,
): 'cloze_correct_nohint' | 'cloze_correct_hint' | 'cloze_wrong' {
  if (outcome === 'correct') return 'cloze_correct_nohint';
  if (outcome === 'correct_wrong_tone') return 'cloze_correct_hint';
  return 'cloze_wrong';
}

/** 1 in 3 rung-3 (typed) items with an available sentence becomes a reorder
 * exercise instead — phase doc §5's "exercise variety... reuse same
 * infrastructure", interleaved into the main ladder rather than bolted on
 * as a disconnected screen, so it still has a clear item/card to grade. */
function useReorderSubstitution(item: SessionItem | undefined): boolean {
  return useMemo(() => {
    if (!item || item.exerciseKind !== 'typed' || !item.source) return false;
    // Deterministic-ish on the item id so it doesn't flicker on re-render.
    let hash = 0;
    for (const ch of item.card.item.id) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
    return hash % 3 === 0;
  }, [item]);
}

export function ClozePage() {
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();

  const [dueCards, setDueCards] = useState<SkillCard[] | null>(null);
  // Phase 21: New cards (introduced, never answered) come from their own query, picked by the one "new" rule.
  const [newCards, setNewCards] = useState<SkillCard[] | null>(null);
  // Phase 29 Part B.4: Cloze's share of the one new-word allowance (the ledger's).
  const [newAllowed, setNewAllowed] = useState(0);
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);
  const [chatLines, setChatLines] = useState<Awaited<ReturnType<typeof allChatLines>> | null>(null);
  const [journalSentences, setJournalSentences] = useState<JournalSentenceSource[] | null>(null);
  // Phase 47 Part B: the journal fixes Cloze may show (every answer word known), and how many wait.
  const [errorItems, setErrorItems] = useState<ErrorItem[] | null>(null);
  const [waitingFixes, setWaitingFixes] = useState(0);
  const [answerKnown, setAnswerKnown] = useState<AnswerKnown | undefined>(undefined);
  // Phase 47 Part A: outside the review session, Cloze practises every answered word.
  const [practiceCards, setPracticeCards] = useState<SkillCard[]>([]);
  const [practiceWords, setPracticeWords] = useState(0);
  const practiceMode = useRef(false);
  // cards whose counted answer of the day was just given (a guard while the ledger rebuilds)
  const countedToday = useRef(new Set<string>());
  // Phase 16: sentences reported earlier — never offered as a cloze again.
  const [excluded, setExcluded] = useState<Set<string> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Phase 16: "Thanks, this one won't come back." + Undo, and what each answered
  // card needs to be taken back exactly.
  const [notice, setNotice] = useState<{ undo: () => Promise<void> } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const answered = useRef(
    new Map<
      number,
      {
        outcome: Outcome | 'error-correct' | 'error-wrong';
        undo?: () => Promise<void>;
        redo?: () => Promise<void>;
        /** The queue before an "Again" re-queue (Undo puts it back). */
        prevSession?: SessionEntry[];
      }
    >(),
  );
  // Phase 27 (Phase 21 "Again"): a card still in a short learning step (a miss, or a new word's first
  // answers) comes back later in this sitting until it leaves the step.
  function requeueStep(replace: SessionEntry): SessionEntry[] | undefined {
    if (!session) return undefined;
    const prev = session;
    // Phase 37: the retry copy says "Again" (the card just answered stays as it was shown).
    const next = requeueInSitting(session, index, describeClozeEntry, { replace });
    setSession(next.map((e, i) => (i !== index && e === replace && e.kind === 'card' ? { ...e, item: { ...e.item, again: true as const } } : e)));
    return prev;
  }
  // Phase 21: a missed error-bank item comes back once later in the session ("Again", as in Review).
  const requeued = useRef(new Set<string>());
  function requeueMissed(entry: SessionEntry): SessionEntry[] | undefined {
    if (!session) return undefined;
    const key = describeClozeEntry(entry).keys[0]!;
    if (requeued.current.has(key)) return undefined;
    requeued.current.add(key);
    const prev = session;
    setSession(requeueAgain(session, index, describeClozeEntry));
    return prev;
  }
  // Phase 21: "Undo" takes back the last answer and shows that item again.
  const [undoable, setUndoable] = useState<number | null>(null);
  // Phase 7: the global "My level" — never hides due reviews, only steers
  // sentence-level preference and the new-item pool.
  const { level: learnerLevel } = useCurrentLevel();

  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const ex = await excludedZh(db);
      // Phase 27: this review session's cards (the one set Home, Garden and the badge count).
      const [ledger, lines, journal, errors] = await Promise.all([
        getLedgerNow(now),
        allChatLines(db, scenariosState.scenarios),
        allJournalSentences(db, ex),
        db.errorItems.toArray(),
      ]);
      if (cancelled) return;
      setExcluded(ex);
      setJournalSentences(journal);
      const fixes = ledger.errorItems(errors);
      setErrorItems(fixes.due);
      setWaitingFixes(fixes.waiting.length);
      setAnswerKnown(fixes.known);
      setPracticeCards(ledger.clozePracticeCards());
      setPracticeWords(ledger.clozePracticeWordCount());
      // Phase 23: reading cards (pinyin and tones) are practised in Review's Say it and their own tab.
      setDueCards(ledger.session().cards.filter((c) => c.skill !== 'reading'));
      setNewCards(ledger.newCards());
      setTutorIds(ledger.tutorWordIds());
      setNewAllowed(ledger.newAllowance('cloze').allowed);
      // Phase 29 Part B.10: cloze coverage uses the one comprehensible set.
      setKnownIds(ledger.comprehensible().ids);
      setChatLines(lines);
    })();
    return () => {
      cancelled = true;
    };
  }, [lexiconState.status, scenariosState.status, reloadKey]);
  // Phase 21 freshness: anything studied elsewhere (or a sync) reloads the queue while no session runs.
  const sessionRunning = useRef(false);
  useEffect(
    () =>
      onStudyDirty(() => {
        if (!sessionRunning.current) setReloadKey((k) => k + 1);
      }),
    [],
  );

  // Phase 17 Part E: rebuild old journal items and process entries not yet
  // processed (needs the proxy). Unprocessed material stays hidden meanwhile.
  useEffect(() => {
    if (lexiconState.status !== 'ready') return;
    let cancelled = false;
    new JournalService(db, lexiconState.lexicon, learnerService, new FetchTutorLLM())
      .rebuildPending()
      .then(() => !cancelled && setReloadKey((k) => k + 1))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lexiconState.status]);

  const neededLevels = useMemo(() => {
    if (!dueCards || lexiconState.status !== 'ready') return [];
    const levels = new Set<Level>();
    for (const card of dueCards) {
      if (card.item.kind !== 'word') continue;
      const word = lexiconState.lexicon.byId(card.item.id);
      const lv = word ? displayLevel(word) : null;
      if (lv) levels.add(lv);
    }
    return [...levels];
  }, [dueCards, lexiconState]);
  const sentenceBankState = useSentenceBank(neededLevels);
  // Phase 21: the lesson sentences always join the bank (active and catch-up lessons first);
  // the class scope only hides lessons past the class.
  const scope = useClassScope();
  const { focus: studyFocus } = useStudyFocus();
  const textbookSentences = useTextbookSentences(true);
  // Phase 39: sentences from tutoring classes lead the pool for their words.
  const tutorSessions = useTutorSessions();
  const [inputMode, setInputMode] = useAnswerInputMode();
  const { script } = useReadingSettings();

  const [session, setSession] = useState<SessionEntry[] | null>(null);
  // Phase 40 Part E.4: tutoring words lead the pool.
  const [tutorIds, setTutorIds] = useState<ReadonlySet<string>>(new Set());
  // Phase 20: the last Nope in this session (Undo / Change).
  const [nope, setNope] = useState<{ handle: NopeHandle; item: SkillCard['item']; word: string; prev: SessionEntry[]; prevIndex: number } | null>(null);
  const [index, setIndex] = useState(0);
  // Phase 28: the end of a session pushes progress to the server straight away.
  useSaveWhenDone(!!session && session.length > 0 && index >= session.length);
  const [tally, setTally] = useState({ correct: 0, hinted: 0, wrong: 0 });
  const [showBonus, setShowBonus] = useState(false);
  // Phase 15: ~20% of a session is listening exercises for items that already have a listening card.
  const clips = useListeningClips();
  const listeningOn = useListeningEnabled();
  const [slots, setSlots] = useState<Map<number, PlanItem>>(new Map());
  const [doneSlots, setDoneSlots] = useState<Set<number>>(new Set());
  const [slotCardIds, setSlotCardIds] = useState<Set<string>>(new Set());

  const ready =
    lexiconState.status === 'ready' &&
    scenariosState.status === 'ready' &&
    sentenceBankState.status === 'ready' &&
    textbookSentences.status === 'ready' &&
    dueCards !== null &&
    newCards !== null &&
    knownIds !== null &&
    chatLines !== null &&
    journalSentences !== null &&
    excluded !== null &&
    errorItems !== null;
  const dueErrorCount = errorItems?.length ?? 0;

  const lessonIdx = useMemo(() => lessonIndex(getStudyBooks()), [studyFocus]);

  /** Phase 21: the lesson sentences in reach: the active lesson's, then catch-up lessons', then the
   * rest up to the class (+ "Lessons ahead of class"), or up to the active lesson without a class. */
  const lessonSentences = useMemo((): { lead: SentenceBankEntry[]; rest: SentenceBankEntry[] } => {
    if (textbookSentences.status !== 'ready') return { lead: [], rest: [] };
    const active = studyFocus?.enabled ? studyFocus.activeLesson : undefined;
    const limit = scope.enabled ? maxVisibleLesson(scope) : (active?.ordinal ?? 0);
    const visible = textbookSentences.sentences.filter(
      (x) => (sentenceOrdinal(x) ?? Infinity) <= limit && isUsableSentence(x.zh, excluded ?? new Set()),
    );
    const leadLessons = [...(active ? [active] : []), ...(studyFocus?.enabled ? studyFocus.reviewLessons : [])];
    const leadKey = (bookId: string, n: number) => `${bookId}:${n}`;
    const order = new Map(leadLessons.map((l, i) => [leadKey(l.bookId, l.n), i]));
    const lead = visible
      .filter((x) => x.lesson !== undefined && order.has(leadKey(sentenceBookId(x), x.lesson)))
      .sort((a, b) => order.get(leadKey(sentenceBookId(a), a.lesson!))! - order.get(leadKey(sentenceBookId(b), b.lesson!))!);
    const leadSet = new Set(lead);
    return { lead, rest: visible.filter((x) => !leadSet.has(x) && levelIndex(x.level) <= levelIndex(learnerLevel)) };
  }, [textbookSentences, studyFocus, scope, excluded, learnerLevel]);

  /** Phase 21: the session is built before it is offered, so the button shows its real size. */
  const planned = useMemo(() => {
    if (!ready || lexiconState.status !== 'ready' || sentenceBankState.status !== 'ready') return null;
    const now = new Date();
    const seed = newSessionSeed('cloze');
    // Phase 29 Part B.4: no new cards while reviews are backed up or the session's cap is used, half
    // while a backlog builds (the ledger's one allowance, Cloze's base).
    const allowed = newAllowed;
    // Phase 21: the one "new" rule (study focus first, then catch-up lessons); cloze is words only.
    const picked = pickNewForSession({
      newCards: newCards!.filter((c) => c.item.kind === 'word' && c.skill !== 'reading'),
      focus: studyFocus,
      lessonIdx,
      allowed,
    });
    const freshItems = picked.items
      .filter((i) => i.kind === 'word' && lexiconState.lexicon.byId(i.id))
      .map((i): SkillCard => ({ ...newSessionCard(i, now), state: 'introduced' }));
    const fresh = [...picked.cards, ...freshItems];
    const shared = {
      seed,
      recent: recentShown(),
      lexicon: lexiconState.lexicon,
      knownIds: knownIds!,
      learnerLevel,
      journalSentences: journalSentences!,
      chatLines: chatLines!,
      excludeZh: excluded!,
      // Phase 14: textbook-first picks, and sentences tagged with the active lesson lead the bank.
      // Phase 40: tutoring words before everything else.
      ...(studyFocus?.enabled || tutorIds.size > 0
        ? {
            rank: (c: SkillCard) =>
              c.item.kind === 'word' && tutorIds.has(c.item.id)
                ? -1e6
                : studyFocus?.enabled
                  ? studyRank(studyFocus, (i) => lessonIdx.get(`${i.kind}:${i.id}`), c.item)
                  : 0,
          }
        : {}),
      bankSentences: [
        ...tutorBankSentences(tutorSessions, lexiconState.lexicon).filter((x) => isUsableSentence(x.zh, excluded!)),
        ...lessonSentences.lead,
        ...sentenceBankState.sentences,
        ...lessonSentences.rest,
      ],
      errorItems: errorItems!,
      ...(answerKnown ? { known: answerKnown } : {}),
      now,
    };
    // Phase 47 Part A.1: the review session's cards (and its new share) while it has any word clozes.
    // Once the session is done (or between sessions) its new share is spent too: practice instead.
    const sessionOpen = dueCards!.some((c) => c.item.kind === 'word');
    const built = buildMixedSession(sessionOpen ? [...dueCards!, ...fresh] : [], shared);
    if (built.some((e) => e.kind === 'card')) return { built, seed, mode: 'session' as const };
    // Part A.2/A.4: otherwise practice over every answered word (weakest first), never a new word;
    // under 10 answered words there is nothing to practise yet.
    if (practiceWords < CLOZE_CONFIG.practiceMinWords) return { built: [] as SessionEntry[], seed, mode: 'few' as const };
    const { rank: _rank, ...noRank } = shared;
    const practice = buildMixedSession(practiceCards, { ...noRank, keepOrder: true });
    return { built: practice, seed, mode: 'practice' as const };
  }, [ready, dueCards, newCards, knownIds, journalSentences, chatLines, excluded, errorItems, answerKnown, practiceCards, practiceWords, lessonSentences, studyFocus, newAllowed, learnerLevel, tutorSessions, tutorIds]);

  function startSession() {
    if (!planned || lexiconState.status !== 'ready') return;
    const { built, seed } = planned;
    practiceMode.current = planned.mode === 'practice';
    countedToday.current.clear();
    logSessionOrder('cloze', seed, built.length, sessionMeta(built)?.deferred.length ?? 0);
    // Phase 37: words left out because their only sentences were already in this session.
    const skipped = clozeSessionMeta(built)?.skippedNoFreshSentence ?? [];
    if (skipped.length) console.info(`[session] cloze left out (no fresh sentence): ${skipped.join(', ')}`);
    answered.current.clear();
    sessionRunning.current = true;
    setUndoable(null);
    setSession(built);
    setSlots(new Map());
    setDoneSlots(new Set());
    if (listeningOn && clips.ready) void buildListeningSlots(built, lexiconState.lexicon);
    setIndex(0);
    setTally({ correct: 0, hinted: 0, wrong: 0 });
    setShowBonus(false);
  }

  /** Phase 21: back to the start screen; the queue reloads (it may have changed elsewhere). */
  function endSession() {
    sessionRunning.current = false;
    setSession(null);
    setUndoable(null);
    setReloadKey((k) => k + 1);
  }

  async function buildListeningSlots(built: readonly OrderedEntry[], lexicon: Lexicon) {
    const length = built.length;
    const now = new Date();
    const cards = await ensureListeningCards(clips.hasClip, now);
    // Phase 21: the listening extras follow the study order too.
    const rankOf = (c: (typeof cards)[number]) =>
      studyFocus?.enabled ? studyRank(studyFocus, (i) => lessonIdx.get(`${i.kind}:${i.id}`), c.item) : 0;
    // Phase 29 Part B.2: listening extras come from listening's own queue (the ledger's).
    const practiced = (await getLedgerNow(now))
      .practice('listening')
      .due.map((c, i) => ({ c, i, r: rankOf(c) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c);
    const n = Math.min(practiced.length, Math.round(length * LISTENING_CONFIG.mixShare));
    if (n <= 0) return;
    const plan = planListenSession({
      lexicon,
      dueListening: practiced,
      newWordIds: [],
      newAllowed: 0,
      hasClip: clips.hasClip,
      sentences: [],
      size: n,
    });
    // Phase 19: spread through the session, never within the gap of a cloze on the same word.
    const next = placeExtras(built, plan, describeClozeEntry, describePlanItem);
    setSlotCardIds(new Set(cards.map((c) => c.item.id)));
    setSlots(next);
  }

  async function recordOutcome(item: SessionItem, outcome: Outcome) {
    const now = new Date();
    noteShown(describeClozeEntry({ kind: 'card', item }).keys, now);
    // Phase 37: one cloze per word; the answer counts for each of the word's cards in this session.
    // Phase 47 Part A.3: in practice, a card's first answer of the day is a counted review, later
    // ones that day are practice only (Phase 45).
    const practising = practiceMode.current;
    const cardKey = (c: Pick<SkillCard, 'item' | 'skill'>) => `${c.item.kind}:${c.item.id}|${c.skill}`;
    let all = clozeAnswerEvidence(item, evidenceKindFor(outcome), now);
    if (practising) {
      const ledger = await getLedgerNow(now);
      all = clozePracticeEvidence(item, evidenceKindFor(outcome), now, (c) => !countedToday.current.has(cardKey(c)) && ledger.practiceCounts(c));
      for (const e of all) if (e.kind.startsWith('review_')) countedToday.current.add(cardKey(e));
    }
    const [evidence, ...others] = all;
    const handle = await learnerService.recordUndoable(evidence!, now);
    const otherHandles: { undo: () => Promise<void> }[] = [];
    for (const e of others) otherHandles.push(await learnerService.recordUndoable(e, now));
    const prevSession = practising
      ? outcome === 'wrong'
        ? requeueMissed({ kind: 'card', item: { ...item, card: handle.card ?? item.card } })
        : undefined
      : stepInSitting(handle.card, now)
        ? requeueStep({ kind: 'card', item: { ...item, card: handle.card! } })
        : undefined;
    answered.current.set(index, {
      outcome,
      ...(prevSession ? { prevSession } : {}),
      undo: async () => {
        for (const h of [...otherHandles].reverse()) await h.undo();
        await handle.undo();
        for (const e of all) countedToday.current.delete(cardKey(e));
      },
      redo: async () => {
        for (const e of [evidence!, ...others]) await learnerService.record(e, now);
      },
    });
    setTally((t) => ({
      correct: t.correct + (outcome === 'correct' ? 1 : 0),
      hinted: t.hinted + (outcome === 'correct_wrong_tone' ? 1 : 0),
      wrong: t.wrong + (outcome === 'wrong' ? 1 : 0),
    }));
    setUndoable(index);
  }

  /** Phase 21: "I think mine is right too" on a sentence cloze: the answer counts as right word,
   * and the sentence is reported (another answer fits) so it is not used again. */
  async function mineIsRight(item: SessionItem) {
    const given = answered.current.get(index);
    if (!given || given.outcome !== 'wrong') return;
    await given.undo?.();
    if (given.prevSession) setSession(given.prevSession);
    setTally((t) => ({ ...t, wrong: t.wrong - 1 }));
    await recordOutcome(item, 'correct_wrong_tone');
    if (item.source) {
      const at = new Date();
      const profileId = currentSession()?.profileId ?? 'unknown';
      const meta = { zh: item.source.zh, sourceKind: item.source.sourceKind as 'journal' | 'chat' | 'bank', sourceLabel: item.source.sourceLabel };
      await reportSource(db, meta, { reason: 'other_answer_fits', note: '', profileId }, at);
      await alsoInOtherProfiles(meta.sourceKind, profileId, (other) =>
        reportSource(other, meta, { reason: 'other_answer_fits', note: '', profileId }, at),
      );
    }
  }

  /** Phase 21: take back the last answer and show that item again. */
  async function undoLast() {
    if (undoable === null) return;
    const at = undoable;
    const given = answered.current.get(at);
    answered.current.delete(at);
    setUndoable(null);
    if (!given) return;
    await given.undo?.();
    if (given.prevSession) {
      const e = given.prevSession[at];
      if (e) requeued.current.delete(describeClozeEntry(e).keys[0]!);
      setSession(given.prevSession);
    }
    setTally((t) => ({
      correct: t.correct - (given.outcome === 'correct' || given.outcome === 'error-correct' ? 1 : 0),
      hinted: t.hinted - (given.outcome === 'correct_wrong_tone' ? 1 : 0),
      wrong: t.wrong - (given.outcome === 'wrong' || given.outcome === 'error-wrong' ? 1 : 0),
    }));
    setAttempt((n) => n + 1);
    setIndex(at);
  }

  /** Phase 5 §7: an error-bank answer reschedules the error item's own FSRS
   * card. It deliberately writes no learner Evidence — an error item is a
   * sentence-level drill, not a vocabulary-item review. */
  async function recordErrorOutcome(error: ErrorItem, outcome: ErrorOutcome) {
    const at = new Date();
    noteShown(describeClozeEntry({ kind: 'error', error }).keys, at);
    // Phase 21: re-read it first (a sync or another tab may have reviewed it since the session began).
    const current = (await db.errorItems.get(error.id)) ?? error;
    await db.errorItems.put(reviewErrorItem(current, outcome, at));
    const paid = outcome === 'correct' ? await gameService.onErrorFixed(error.id, at) : [];
    const prevSession = outcome === 'wrong' ? requeueMissed({ kind: 'error', error }) : undefined;
    answered.current.set(index, {
      outcome: outcome === 'wrong' ? 'error-wrong' : 'error-correct',
      ...(prevSession ? { prevSession } : {}),
      undo: async () => {
        await db.errorItems.put(current);
        await gameService.revoke(paid, new Date());
      },
    });
    setUndoable(index);
    setTally((t) => ({
      correct: t.correct + (outcome === 'correct' ? 1 : 0),
      hinted: t.hinted + (outcome === 'hint' ? 1 : 0),
      wrong: t.wrong + (outcome === 'wrong' ? 1 : 0),
    }));
  }

  /** Phase 17 Part D: the learner's answer was accepted after all ("I think mine
   * is right too", or a Fix-my-sentence rewrite that checked out). The item,
   * which now accepts that answer, is rescheduled from the card it had BEFORE
   * this session touched it, so the wrong grade is undone exactly. */
  async function regradeError(before: ErrorItem, updated: ErrorItem) {
    const at = new Date();
    const prior = answered.current.get(index);
    const stored = (await db.errorItems.get(before.id)) ?? before;
    await db.errorItems.put(reviewErrorItem({ ...updated, card: before.card }, 'correct', at));
    const paid = await gameService.onErrorFixed(before.id, at);
    answered.current.set(index, {
      outcome: 'error-correct',
      undo: async () => {
        await db.errorItems.put(stored);
        await gameService.revoke(paid, new Date());
      },
    });
    setTally((t) => ({
      ...t,
      correct: t.correct + 1,
      wrong: t.wrong - (prior?.outcome === 'error-wrong' ? 1 : 0),
    }));
  }

  async function reconsider(item: ErrorItem, answer: ItemAnswer): Promise<Reconsidered> {
    if (lexiconState.status !== 'ready')
      return { accepted: false, reason: 'The lexicon is still loading.' };
    return reconsiderAnswer(
      {
        lexicon: lexiconState.lexicon,
        llm: new FetchTutorLLM(),
        protectedTerms: await getProtectedTerms(db),
      },
      item,
      answer,
    );
  }

  function next() {
    setIndex((i) => i + 1);
  }
  // Bumped by Undo so the item re-mounts fresh.
  const [attempt, setAttempt] = useState(0);

  /** Phase 16 Part C: the card leaves the session at once; an answer already
   * given is undone (evidence removed, card restored exactly), so a bad cloze
   * never counts as a lapse. The word itself stays in review and gets another
   * sentence next time. */
  async function reportCurrent(entry: SessionEntry, reason: ClozeReportReason, note: string) {
    const at = new Date();
    const profileId = currentSession()?.profileId ?? 'unknown';
    const given = answered.current.get(index);
    answered.current.delete(index);
    // A reported item doesn't come back as an "Again" either.
    if (given?.prevSession) setSession(given.prevSession);
    if (given) {
      setTally((t) => ({
        correct: t.correct - (given.outcome === 'correct' || given.outcome === 'error-correct' ? 1 : 0),
        hinted: t.hinted - (given.outcome === 'correct_wrong_tone' ? 1 : 0),
        wrong: t.wrong - (given.outcome === 'wrong' || given.outcome === 'error-wrong' ? 1 : 0),
      }));
    }
    let undoReport: () => Promise<void>;
    if (entry.kind === 'error') {
      // `entry.error` is the item as it was before this session touched it,
      // so writing it back restores its card exactly.
      await reportJournalItem(db, entry.error, { reason, note, profileId }, at);
      undoReport = () => restoreJournalItem(db, entry.error);
    } else {
      await given?.undo?.();
      const src = entry.item.source!;
      const meta = { zh: src.zh, sourceKind: src.sourceKind as 'journal' | 'chat' | 'bank', sourceLabel: src.sourceLabel };
      await reportSource(db, meta, { reason, note, profileId }, at);
      await alsoInOtherProfiles(meta.sourceKind, profileId, (other) =>
        reportSource(other, meta, { reason, note, profileId }, at),
      );
      undoReport = async () => {
        await restoreSource(db, meta.zh);
        await alsoInOtherProfiles(meta.sourceKind, profileId, (other) => restoreSource(other, meta.zh));
        await given?.redo?.();
      };
    }
    clearTimeout(noticeTimer.current);
    setNotice({
      undo: async () => {
        await undoReport();
        if (given) setTally((t) => ({
          correct: t.correct + (given.outcome === 'correct' || given.outcome === 'error-correct' ? 1 : 0),
          hinted: t.hinted + (given.outcome === 'correct_wrong_tone' ? 1 : 0),
          wrong: t.wrong + (given.outcome === 'wrong' || given.outcome === 'error-wrong' ? 1 : 0),
        }));
      },
    });
    noticeTimer.current = setTimeout(() => setNotice(null), 8000);
    setUndoable(null);
    setIndex((i) => i + 1);
  }

  const noticeEl = notice && (
    <ReportNotice
      onUndo={() => {
        const n = notice;
        setNotice(null);
        void n.undo();
      }}
      onGone={() => setNotice(null)}
    />
  );

  if (lexiconState.status === 'loading' || scenariosState.status === 'loading')
    return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (scenariosState.status === 'error')
    return <p>Failed to load scenarios: {scenariosState.error}</p>;

  if (!session) {
    return (
      <div className="cloze-page">
        <h1>Cloze review</h1>
        {lexiconState.status === 'ready' && <GrammarRound lexicon={lexiconState.lexicon} />}
        {!ready || !planned ? (
          <p>Loading your review queue…</p>
        ) : planned.mode === 'few' ? (
          <>
            <EmptySprout />
            <p data-testid="cloze-few-words">{LEARN_WORDS_FIRST}</p>
            <button className="btn-primary" data-testid="cloze-go-review" onClick={() => goTo('review')}>
              Open Review
            </button>
          </>
        ) : planned.built.length === 0 ? (
          <>
            <EmptySprout />
            <p data-testid="cloze-empty">{NOTHING_DUE}</p>
          </>
        ) : (
          <>
            {dueErrorCount > 0 && planned.built.some((e) => e.kind === 'error') && (
              <p className="cloze-level-note">
                {dueErrorCount} sentence{dueErrorCount === 1 ? '' : 's'} from your journal
                corrections {dueErrorCount === 1 ? 'is' : 'are'} due.
              </p>
            )}
            <button className="btn-primary" onClick={startSession} data-testid="cloze-start">
              {clozeStartLabel(planned.built, planned.mode)}
            </button>
          </>
        )}
        {ready && waitingFixes > 0 && (
          <p className="cloze-level-note" data-testid="cloze-waiting-fixes">
            <button type="button" className="link-button" onClick={() => goTo('reported', 'waiting-fixes')}>
              {clozeWaitingFixes(waitingFixes)}
            </button>
          </p>
        )}
      </div>
    );
  }

  const undoEl = undoable !== null && answered.current.has(undoable) && (
    <button type="button" className="cloze-undo" data-testid="cloze-undo" onClick={() => void undoLast()}>
      {UNDO}
    </button>
  );
  const entry = session[index];
  const listenNow = slots.get(index) && !doneSlots.has(index) ? slots.get(index) : undefined;
  if (listenNow && entry && lexiconState.status === 'ready') {
    return (
      <div className="cloze-page">
        <div className="cloze-header">
          <span data-testid="cloze-counter">
            {index + 1} of {session.length}
          </span>
          {undoEl}
          <span className="cloze-badge">Listening</span>
        </div>
        <ListenRunner
          key={`slot-${index}`}
          plan={[listenNow]}
          lexicon={lexiconState.lexicon}
          clips={clips}
          cardIds={slotCardIds}
          onFinished={() => setDoneSlots((d) => new Set(d).add(index))}
        />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="cloze-page">
        {noticeEl}
        <h1>Session complete</h1>
        <ul className="cloze-summary">
          <li>{tally.correct} correct, no hint</li>
          <li>{tally.hinted} right word, wrong tone</li>
          <li>{tally.wrong} wrong</li>
        </ul>
        {undoEl}
        <button onClick={endSession}>Back</button>
        <button onClick={() => setShowBonus((v) => !v)}>
          {showBonus ? 'Hide' : 'Show'} bonus practice
        </button>
        {showBonus && <BonusPractice />}
      </div>
    );
  }

  if (entry.kind === 'error') {
    return (
      <div className="cloze-page">
        <div className="cloze-header">
          <span data-testid="cloze-counter">
            {index + 1} of {session.length}
          </span>
          {undoEl}
          <span className="cloze-badge">From your journal</span>
          {entry.error.pattern && <span className="cloze-badge">{entry.error.pattern}</span>}
        </div>
        {noticeEl}
        <ErrorExerciseView
          key={`${entry.error.id}:${attempt}`}
          item={entry.error}
          lexicon={lexiconState.lexicon}
          reconsider={reconsider}
          onAnswer={(outcome) => recordErrorOutcome(entry.error, outcome)}
          onRegrade={(updated) => void regradeError(entry.error, updated)}
          onNext={next}
        />
        <ReportButton onReport={(reason, note) => void reportCurrent(entry, reason, note)} />
      </div>
    );
  }

  const item = entry.item;

  /** Phase 20: one tap takes the word out of review, with all its cards left in this session. */
  async function sayNope(choice: NopeChoice = 'not_now') {
    if (!session) return;
    const ref = item.card.item;
    const handle = await nopeWord(ref, choice);
    const same = (e: SessionEntry) => e.kind === 'card' && e.item.card.item.id === ref.id && e.item.card.item.kind === ref.kind;
    setNope({ handle, item: ref, word: item.word.headword, prev: session, prevIndex: index });
    setSession(session.filter((e, i) => i < index || !same(e)));
  }

  const nopeEl = nope && (
    <NopeToast
      word={nope.word}
      choice={nope.handle.choice}
      onUndo={() =>
        void nope.handle.undo().then(() => {
          setSession(nope.prev);
          setIndex(nope.prevIndex);
          setNope(null);
        })
      }
      onChange={(c) =>
        void nope.handle.undo().then(async () => setNope({ ...nope, handle: await nopeWord(nope.item, c) }))
      }
      onClose={() => setNope(null)}
    />
  );

  return (
    <div className="cloze-page">
      <div className="cloze-header">
        <span data-testid="cloze-counter">
            {index + 1} of {session.length}
          </span>
          {undoEl}
        {item.again && <span className="cloze-badge" data-testid="cloze-again">{AGAIN}</span>}
        {practiceMode.current && <span className="cloze-badge" data-testid="cloze-practice">{PRACTICE}</span>}
        <span className="cloze-badge">Rung {item.card.clozeRung}</span>
        <span className="cloze-badge">{item.card.skill}</span>
      </div>
      {noticeEl}
      {item.source && <div className="cloze-source-label">{item.source.sourceLabel}</div>}

      <ExerciseView
        key={`${item.card.item.id}:${index}:${attempt}`}
        item={item}
        lexicon={lexiconState.lexicon}
        onAnswer={(outcome) => recordOutcome(item, outcome)}
        onMineIsRight={() => void mineIsRight(item)}
        onNext={next}
        inputMode={inputMode}
        setInputMode={setInputMode}
        script={script}
      />
      {nopeEl}
      <NopeButton onNope={() => void sayNope()} />
      {item.source && (
        <ReportButton onReport={(reason, note) => void reportCurrent(entry, reason, note)} />
      )}
    </div>
  );
}

interface ViewShared {
  onMineIsRight: () => void;
  inputMode: AnswerInputMode;
  setInputMode: (m: AnswerInputMode) => void;
  script: AnnotationScript;
}

export function ExerciseView({
  item,
  lexicon,
  onAnswer,
  onNext,
  ...shared
}: {
  item: SessionItem;
  lexicon: Lexicon;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
} & ViewShared) {
  const [answered, setAnswered] = useState<Outcome | null>(null);
  const useReorder = useReorderSubstitution(item);
  const handleAnswer = (o: Outcome) => {
    setAnswered(o);
    onAnswer(o);
  };

  const exercise = item.source ? buildClozeExercise(item.word, item.source, lexicon) : null;

  if (item.exerciseKind === 'typed' && useReorder && item.source) {
    return (
      <ReorderExerciseView
        {...shared}
        item={item}
        lexicon={lexicon}
        answered={answered}
        onAnswer={handleAnswer}
        onNext={onNext}
      />
    );
  }

  if (item.exerciseKind === 'typed') {
    return (
      <TypedExerciseView
        {...shared}
        lexicon={lexicon}
        item={item}
        exercise={exercise}
        answered={answered}
        onAnswer={handleAnswer}
        onNext={onNext}
      />
    );
  }

  return (
    <ChoiceExerciseView
      {...shared}
      item={item}
      lexicon={lexicon}
      exercise={exercise}
      answered={answered}
      onAnswer={handleAnswer}
      onNext={onNext}
    />
  );
}

function SentenceWithBlank({
  sentence,
  start,
  end,
}: {
  sentence: string;
  start: number;
  end: number;
}) {
  return (
    <p className="cloze-sentence">
      {sentence.slice(0, start)}
      <span className="cloze-blank">____</span>
      {sentence.slice(end)}
    </p>
  );
}

function ChoiceExerciseView({
  item,
  lexicon,
  exercise,
  answered,
  onAnswer,
  onNext,
  script,
}: {
  item: SessionItem;
  lexicon: Lexicon;
  exercise: ReturnType<typeof buildClozeExercise>;
  answered: Outcome | null;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
} & ViewShared) {
  const [options] = useState<ChoiceOption[]>(() =>
    item.exerciseKind === 'word_bank'
      ? buildWordBankOptions(item.word, lexicon)
      : buildMultipleChoiceOptions(item.word, lexicon),
  );
  const [picked, setPicked] = useState<string | null>(null);

  function choose(option: ChoiceOption) {
    if (answered) return;
    setPicked(option.word.id);
    onAnswer(option.isCorrect ? 'correct' : 'wrong');
  }

  useKeyboardShortcut('choice-1', () => { if (options[0]) choose(options[0]); }, !answered && Boolean(options[0]));
  useKeyboardShortcut('choice-2', () => { if (options[1]) choose(options[1]); }, !answered && Boolean(options[1]));
  useKeyboardShortcut('choice-3', () => { if (options[2]) choose(options[2]); }, !answered && Boolean(options[2]));
  useKeyboardShortcut('choice-4', () => { if (options[3]) choose(options[3]); }, !answered && Boolean(options[3]));
  useKeyboardShortcut('next', () => onNext(), Boolean(answered));

  return (
    <div className="cloze-exercise">
      {exercise ? (
        <SentenceWithBlank
          sentence={exercise.sentence}
          start={exercise.blankStart}
          end={exercise.blankEnd}
        />
      ) : (
        <p className="cloze-prompt">
          Which word means: <strong>{glossFor(item.word) || '(no gloss)'}</strong>?
        </p>
      )}
      <div className="cloze-options">
        {options.map((o) => (
          <button
            key={o.word.id}
            className={`cloze-chip ${answered && o.isCorrect ? 'cloze-chip--correct' : ''} ${answered && picked === o.word.id && !o.isCorrect ? 'cloze-chip--wrong' : ''}`}
            disabled={Boolean(answered)}
            onClick={() => choose(o)}
          >
            {o.word.headword}
          </button>
        ))}
      </div>
      {answered && (
        <Feedback
          outcome={answered}
          word={item.word}
          onNext={onNext}
          sentenceZh={item.source?.zh}
          lexicon={lexicon}
          script={script}
        />
      )}
    </div>
  );
}

function TypedExerciseView({
  item,
  lexicon,
  exercise,
  answered,
  onAnswer,
  onNext,
  onMineIsRight,
  inputMode,
  setInputMode,
  script,
}: {
  item: SessionItem;
  lexicon: Lexicon;
  exercise: ReturnType<typeof buildClozeExercise>;
  answered: Outcome | null;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
} & ViewShared) {
  // Phase 21: the remembered answer input mode (Settings); production always asks for the characters.
  const [mode, setModeState] = useState<ClozeInputMode>(
    item.card.skill === 'production' ? 'hanzi' : inputMode === 'characters' ? 'hanzi' : inputMode,
  );
  const setMode = (m: ClozeInputMode) => {
    setModeState(m);
    setInputMode(m === 'hanzi' ? 'characters' : m);
  };
  const [typed, setTyped] = useState('');

  function submit() {
    if (answered || !typed.trim()) return;
    onAnswer(gradeClozeAnswer(typed, item.word, mode));
  }

  useKeyboardShortcut('submit', submit, !answered);
  useKeyboardShortcut('next', () => onNext(), Boolean(answered));

  return (
    <div className="cloze-exercise">
      {exercise ? (
        <SentenceWithBlank
          sentence={exercise.sentence}
          start={exercise.blankStart}
          end={exercise.blankEnd}
        />
      ) : (
        <p className="cloze-prompt">
          {mode === 'hanzi' ? (
            <>
              Type the Chinese word for: <strong>{glossFor(item.word)}</strong>
            </>
          ) : (
            <>
              Type the reading of: <strong lang="zh-Hant">{item.word.headword}</strong>
            </>
          )}
        </p>
      )}
      <div className="cloze-mode-toggle">
        {(['hanzi', 'pinyin', 'zhuyin'] as const).map((m) => (
          <button
            key={m}
            className={mode === m ? 'cloze-mode--active' : ''}
            onClick={() => setMode(m)}
            disabled={Boolean(answered)}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="cloze-input-row">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={Boolean(answered)}
          placeholder={
            mode === 'hanzi' ? '中文…' : mode === 'pinyin' ? 'ni3 hao3 / nǐ hǎo' : 'ㄋㄧˇ ㄏㄠˇ'
          }
          // iPhone: no auto-capitals / auto-correct on a typed answer, the right
          // Chinese keyboard, and a "done" key. (inputMode keeps Latin keyboards for pinyin.)
          lang={mode === 'pinyin' ? 'en' : 'zh-Hant-TW'}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button onClick={submit} disabled={Boolean(answered) || !typed.trim()}>
          Submit
        </button>
      </div>
      {answered && (
        <Feedback
          outcome={answered}
          word={item.word}
          onNext={onNext}
          sentenceZh={item.source?.zh}
          lexicon={lexicon}
          script={script}
          {...(answered === 'wrong' && exercise ? { onMineIsRight } : {})}
        />
      )}
    </div>
  );
}

function ReorderExerciseView({
  item,
  lexicon,
  answered,
  onAnswer,
  onNext,
  script,
}: {
  item: SessionItem;
  lexicon: Lexicon;
  answered: Outcome | null;
  onAnswer: (o: Outcome) => void;
  onNext: () => void;
} & ViewShared) {
  const [exercise] = useState(() => buildReorderExercise(item.source!.zh, lexicon));
  const order = exercise.shuffled;
  const [picked, setPicked] = useState<number[]>([]);

  function pick(i: number) {
    if (answered || picked.includes(i)) return;
    setPicked((p) => [...p, i]);
  }

  function submit() {
    if (answered || picked.length !== order.length) return;
    const attempt = picked.map((i) => order[i]);
    const correct = attempt.join('') === exercise.correctOrder.join('');
    onAnswer(correct ? 'correct' : 'wrong');
  }

  return (
    <div className="cloze-exercise">
      <p className="cloze-prompt">Put the sentence back in order:</p>
      <div className="cloze-reorder-answer">{picked.map((i) => order[i]).join('') || ' '}</div>
      <div className="cloze-options">
        {order.map((token, i) => (
          <button
            key={i}
            className="cloze-chip"
            disabled={Boolean(answered) || picked.includes(i)}
            onClick={() => pick(i)}
          >
            {token}
          </button>
        ))}
      </div>
      {!answered && (
        <button onClick={submit} disabled={picked.length !== order.length}>
          Submit
        </button>
      )}
      {answered && (
        <Feedback
          outcome={answered}
          word={item.word}
          onNext={onNext}
          sentenceZh={item.source?.zh}
          correctTextOverride={exercise.correctOrder.join('')}
          lexicon={lexicon}
          script={script}
        />
      )}
    </div>
  );
}

function Feedback({
  outcome,
  word,
  onNext,
  correctTextOverride,
  sentenceZh,
  lexicon,
  script,
  onMineIsRight,
}: {
  outcome: Outcome;
  word: SessionItem['word'];
  onNext: () => void;
  correctTextOverride?: string;
  /** The full sentence the exercise came from: its clip (if any) plays after answering. */
  sentenceZh?: string;
  lexicon: Lexicon;
  script: AnnotationScript;
  /** Phase 21: a typed sentence answer marked wrong may be right too. */
  onMineIsRight?: () => void;
}) {
  const reading = readingText(word, script);
  const [claimed, setClaimed] = useState(false);
  useKeyboardShortcut('next', () => onNext(), true);
  return (
    <div className={`cloze-feedback cloze-feedback--${outcome}`} data-testid="cloze-feedback">
      <p>
        {outcome === 'correct' && FEEDBACK_CORRECT}
        {outcome === 'correct_wrong_tone' && `${FEEDBACK_WRONG_TONE}: ${word.headword} (${reading})`}
        {outcome === 'wrong' &&
          feedbackWrong(correctTextOverride ?? word.headword, correctTextOverride ? undefined : reading)}
      </p>
      {sentenceZh && (
        <p className="cloze-answered-sentence" lang="zh-Hant">
          <AnnotatedInline text={sentenceZh} lexicon={lexicon} script={script} />
        </p>
      )}
      <div className="cloze-audio">
        {sentenceZh && <SpeakerButton kind="sentence" text={sentenceZh} label="the sentence" />}
        <SpeakerButton kind="word" id={word.id} label={word.headword} />
      </div>
      {onMineIsRight && !claimed && (
        <button
          type="button"
          data-testid="cloze-mine-is-right"
          onClick={() => {
            setClaimed(true);
            onMineIsRight();
          }}
        >
          {MINE_IS_RIGHT}
        </button>
      )}
      {claimed && <p className="cloze-level-note">Counted as right. This sentence won&apos;t be used again.</p>}
      <button onClick={onNext}>{NEXT}</button>
    </div>
  );
}

function BonusPractice() {
  const [kind, setKind] = useState<'mainland' | 'le' | null>(null);
  const [exercise, setExercise] = useState<NaturalPairExercise | null>(null);
  const [revealed, setRevealed] = useState(false);

  function start(k: 'mainland' | 'le') {
    setKind(k);
    setExercise(k === 'mainland' ? buildMainlandVsTaiwanExercise() : buildLePlacementExercise());
    setRevealed(false);
  }

  return (
    <div className="cloze-bonus">
      <p>Untracked extra practice — not scheduled by your review queue.</p>
      <div className="cloze-options">
        <button onClick={() => start('mainland')}>Taiwan vs. Mainland</button>
        <button onClick={() => start('le')}>了-placement</button>
      </div>
      {kind && exercise && (
        <div className="cloze-exercise">
          <p className="cloze-prompt">
            {kind === 'mainland' ? 'Which is used in Taiwan?' : 'Which sentence is correct?'}
          </p>
          <div className="cloze-options">
            <button onClick={() => setRevealed(true)}>{exercise.optionA}</button>
            <button onClick={() => setRevealed(true)}>{exercise.optionB}</button>
          </div>
          {revealed && (
            <p className="cloze-bonus-answer">
              Correct: {exercise.correctIndex === 0 ? exercise.optionA : exercise.optionB}
              {exercise.note && <> — {exercise.note}</>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
