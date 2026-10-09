import { useEffect, useMemo, useRef, useState } from 'react';
import { isDueListening } from '@anan/core';
import {
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
  gradeClozeAnswer,
  reviewErrorItem,
  selectDueErrorItems,
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
import { useReviewSettings } from '../lib/review-settings.js';
import { useReviewStatus } from '../lib/review-status.js';
import { DEFAULT_SESSION_CONFIG, newWordState } from '@anan/core';
import type { NopeHandle } from '../lib/learner-service.js';
import type { NopeChoice } from '@anan/core';
import { logSessionOrder, noteShown, recentShown } from '../lib/session-recent.js';
import {
  describePlanItem,
  itemKey,
  newSessionSeed,
  requeueAgain,
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
  feedbackWrong,
} from '../lib/labels.js';
import { glossFor } from '@anan/core';
import { GrammarRound } from './GrammarStep.js';
import './ClozePage.css';

export type Outcome = 'correct' | 'correct_wrong_tone' | 'wrong';

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
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);
  const [chatLines, setChatLines] = useState<Awaited<ReturnType<typeof allChatLines>> | null>(null);
  const [journalSentences, setJournalSentences] = useState<JournalSentenceSource[] | null>(null);
  const [errorItems, setErrorItems] = useState<ErrorItem[] | null>(null);
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
  // Phase 21: a missed item comes back once later in the session ("Again", as in Review).
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
      const [due, fresh, known, lines, journal, errors] = await Promise.all([
        learnerService.dueCards(now),
        learnerService.newCards(),
        learnerService.wordSets(now).then((s) => s.knownIds),
        allChatLines(db, scenariosState.scenarios),
        allJournalSentences(db, ex),
        db.errorItems.toArray(),
      ]);
      if (cancelled) return;
      setExcluded(ex);
      setJournalSentences(journal);
      setErrorItems(errors);
      // Phase 23: reading cards (pinyin and tones) are practised in Review's Say it and their own tab.
      setDueCards(due.filter((c) => c.skill !== 'reading'));
      setNewCards(fresh);
      setKnownIds(known);
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
      if (word?.level) levels.add(word.level);
    }
    return [...levels];
  }, [dueCards, lexiconState]);
  const sentenceBankState = useSentenceBank(neededLevels);
  // Phase 21: the lesson sentences always join the bank (active and catch-up lessons first);
  // the class scope only hides lessons past the class.
  const scope = useClassScope();
  const { focus: studyFocus } = useStudyFocus();
  const textbookSentences = useTextbookSentences(true);
  const [inputMode, setInputMode] = useAnswerInputMode();
  const { script } = useReadingSettings();

  const [session, setSession] = useState<SessionEntry[] | null>(null);
  const reviewSettings = useReviewSettings();
  const capLeft = useReviewStatus()?.status.capLeft;
  // Phase 20: the last Nope in this session (Undo / Change).
  const [nope, setNope] = useState<{ handle: NopeHandle; item: SkillCard['item']; word: string; prev: SessionEntry[]; prevIndex: number } | null>(null);
  const [index, setIndex] = useState(0);
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
  const dueErrorCount = errorItems
    ? selectDueErrorItems(errorItems, new Date(), Infinity).length
    : 0;

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
    // Phase 20/22: no new cards while reviews are backed up or today's cap is used, half while a backlog
    // builds (the one rule, core `newWordState`, with today's distinct reviews from `reviewStatus`).
    const allowed = newWordState({
      dueNow: dueCards!.length,
      capLeft: capLeft ?? reviewSettings.capPerSession,
      cap: reviewSettings.capPerSession,
      baseNew: DEFAULT_SESSION_CONFIG.maxNewItems,
    }).newAllowed;
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
    const built = buildMixedSession([...dueCards!, ...fresh], {
      config: { maxNewItems: fresh.length },
      seed,
      recent: recentShown(),
      lexicon: lexiconState.lexicon,
      knownIds: knownIds!,
      learnerLevel,
      journalSentences: journalSentences!,
      chatLines: chatLines!,
      excludeZh: excluded!,
      // Phase 14: textbook-first picks, and sentences tagged with the active lesson lead the bank.
      ...(studyFocus?.enabled
        ? {
            rank: (c: SkillCard) =>
              studyRank(studyFocus, (i) => lessonIdx.get(`${i.kind}:${i.id}`), c.item),
          }
        : {}),
      bankSentences: [...lessonSentences.lead, ...sentenceBankState.sentences, ...lessonSentences.rest],
      errorItems: errorItems!,
      now,
    });
    return { built, seed };
  }, [ready, dueCards, newCards, knownIds, journalSentences, chatLines, excluded, errorItems, lessonSentences, studyFocus, reviewSettings.capPerSession, capLeft, learnerLevel]);

  function startSession() {
    if (!planned || lexiconState.status !== 'ready') return;
    const { built, seed } = planned;
    logSessionOrder('cloze', seed, built.length, sessionMeta(built)?.deferred.length ?? 0);
    answered.current.clear();
    requeued.current.clear();
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
    const practiced = cards
      .filter((c) => isDueListening(c, now))
      .map((c, i) => ({ c, i, r: rankOf(c) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c);
    const n = Math.min(practiced.length, Math.round(length * LISTENING_CONFIG.mixShare));
    if (n <= 0) return;
    const plan = planListenSession({
      lexicon,
      dueListening: practiced,
      newWordIds: [],
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
    const evidence = {
      item: item.card.item,
      skill: item.card.skill,
      kind: evidenceKindFor(outcome),
      at: now,
    };
    const handle = await learnerService.recordUndoable(evidence, now);
    const prevSession = outcome === 'wrong' ? requeueMissed({ kind: 'card', item }) : undefined;
    answered.current.set(index, {
      outcome,
      ...(prevSession ? { prevSession } : {}),
      undo: handle.undo,
      redo: async () => {
        await learnerService.record(evidence, now);
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
        ) : planned.built.length === 0 ? (
          <>
            <EmptySprout />
            <p data-testid="cloze-empty">{NOTHING_DUE}</p>
          </>
        ) : (
          <>
            {dueErrorCount > 0 && (
              <p className="cloze-level-note">
                {dueErrorCount} sentence{dueErrorCount === 1 ? '' : 's'} from your journal
                corrections {dueErrorCount === 1 ? 'is' : 'are'} due.
              </p>
            )}
            <button className="btn-primary" onClick={startSession} data-testid="cloze-start">
              Start session ({planned.built.length} item{planned.built.length === 1 ? '' : 's'})
            </button>
          </>
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
