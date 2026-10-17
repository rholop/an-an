// Phase 22 Part A: one review status, the same on every screen. Home, Review, Garden and the nav
// all read their numbers from `reviewStatus`; nothing else counts "due" for display (an
// architecture test enforces it). Phase 23 Part A: the numbers are per review session (morning
// and evening, in the profile's time zone) instead of "due now / later today". Pure; time is
// always injected.

import { REVIEW_PILE_CONFIG } from '../learner/review-pile.config.js';
import type { SkillCard } from '../learner/types.js';
import type { Evidence } from '../types.js';
import {
  countWindowStart,
  DEFAULT_SESSION_SETTINGS,
  sessionAt,
  sessionForDue,
  sessionWindows,
  type SessionName,
  type SessionSettings,
  type SessionWindow,
  windowKey,
} from './review-sessions.js';
import { faceGateOpen, faceStage, releasedFaceKeys } from './face-order.js';
import { recheckDue } from './easy-ratings.js';
import { PROGRESS_CONFIG } from './progress.config.js';
import { inAppAnswers, isActiveCard, isDueBefore, isNewCard, isScheduledCard } from './terms.js';

/** Evidence kinds that are a review answer (they count toward the session cap). */
export const REVIEW_ANSWER_KINDS: ReadonlySet<string> = new Set([
  'review_again',
  'review_hard',
  'review_good',
  'review_easy',
]);

/** Every rated answer that moves a card in a session (Review, Water all's clozes, pinyin practice). */
const RATED_KINDS: ReadonlySet<string> = new Set([
  ...REVIEW_ANSWER_KINDS,
  'cloze_correct_nohint',
  'cloze_correct_hint',
  'cloze_wrong',
  'reading_correct',
  'reading_tone_wrong',
  'reading_wrong',
]);
/** A rated answer that leaves the card unfinished: it comes back in the same session. */
const AGAIN_KINDS: ReadonlySet<string> = new Set(['review_again', 'cloze_wrong', 'reading_wrong']);

export type NewState = 'open' | 'reduced' | 'paused_backlog' | 'limit_reached';
export type SessionState = SessionName | 'between';

type EvidenceLike = Pick<Evidence, 'item' | 'skill' | 'kind' | 'at'> & Partial<Pick<Evidence, 'context'>>;

/** Phase 45: an answer given on "Practise these words" (counted or not). It never starts or fixes a
 * session, never makes a session "done", and counts as done in a session only for that session's own
 * cards. */
const practised = (e: EvidenceLike): boolean => e.context?.practice === true;

export interface ReviewStatus {
  /** The session open now, or 'between' sessions. */
  session: SessionState;
  /** Cards left in this session (0 between sessions). The only number called "due". */
  sessionCards: number;
  /** Same as `sessionCards` (the nav badge, "N due"). */
  dueNow: number;
  /** When this session ends (absent between sessions). */
  sessionEndsAt?: Date;
  /** The next session and how many cards it holds as things stand. */
  nextSession: { name: SessionName; opensAt: Date; count: number };
  /** The last session that ended and how many of its cards are still undone (they roll on). */
  previousSession: { name: SessionName; left: number };
  /** Distinct cards answered in Review this session (between sessions: since the last one ended).
   * An Again repeat counts once. */
  doneThisSession: number;
  cap: number;
  /** Reviews left under the session cap. */
  capLeft: number;
  /** "Review all (N)": this session's cards (Phase 43: never more than the ceiling). */
  reviewAll: number;
  /** "Water all (N)": distinct words with a card in this session. */
  thirstyWords: number;
  thirstyWordIds: string[];
  /** Phase 27: the cards of this session (`sessionCardKey`): the one set that makes a plant thirsty,
   * fills Water all, a plot's button, the lesson page and the badge. Empty between sessions. */
  sessionCardKeys: string[];
  /** Tutoring cards among `sessionCards` (Phase 43: inside the ceiling and the day's limits, first). */
  tutorCards: number;
  /** Phase 27: the next session's cards and words (faint droplets, "N words in the evening session"). */
  nextSessionCardKeys: string[];
  nextSessionWordIds: string[];
  /** New words this session. */
  newState: NewState;
  newMessage?: string;
  /** Phase 43: study-order words with no card yet that may still join this session (its share of
   * the day's new words, in the room under the ceiling). */
  newAllowed: number;
  /** Phase 43 Part C.3: this session's due cards over the ceiling; they wait for the next session. */
  waiting: number;
  /** Phase 43 Part C.1: the session has its first answer (fixed: nothing new joins). */
  started: boolean;
  /** New cards among `sessionCards`. */
  newCards: number;
  /** Phase 43 Part A: what is left of today's new words and new card types. */
  newToday: { wordsLeft: number; facesLeft: number };
  timeZone: string;
}

/** The one wording for each new-word state (Home and Review show the same line). */
export function newStateMessage(state: NewState, cap: number): string | undefined {
  switch (state) {
    case 'paused_backlog':
      return "New words paused until this session's reviews are done.";
    case 'limit_reached':
      return `You've done this session's ${cap} reviews. New words return next session.`;
    case 'reduced':
      return 'Fewer new words this session while reviews catch up.';
    default:
      return undefined;
  }
}

/** New words this session, from how many cards the session holds and what's left under the cap.
 * The one rule every session (Review, Cloze, lesson study) and every screen uses. */
export function newWordState(input: {
  dueNow: number;
  capLeft: number;
  cap?: number;
  baseNew: number;
  newHalfShare?: number;
}): { newState: NewState; newAllowed: number; newMessage?: string } {
  const cap = input.cap ?? REVIEW_PILE_CONFIG.dailyCap;
  const half = input.newHalfShare ?? REVIEW_PILE_CONFIG.newHalfShare;
  let newState: NewState = 'open';
  let newAllowed = input.baseNew;
  if (input.capLeft <= 0) {
    newState = 'limit_reached';
    newAllowed = 0;
  } else if (input.dueNow > cap) {
    // Behind: more in this session than a whole session's cap.
    newState = 'paused_backlog';
    newAllowed = 0;
  } else if (input.dueNow > cap * half) {
    newState = 'reduced';
    newAllowed = Math.floor(input.baseNew / 2);
  }
  const newMessage = newStateMessage(newState, cap);
  return { newState, newAllowed, ...(newMessage ? { newMessage } : {}) };
}

/** One card's key in a session ("word:id|skill"). */
export const sessionCardKey = (c: Pick<SkillCard, 'item' | 'skill'>): string => `${c.item.kind}:${c.item.id}|${c.skill}`;
const cardKey = sessionCardKey;

/** Distinct cards answered in Review between `since` and `now` (from already-active evidence).
 * `skip`: cards left out of the count (Phase 40: tutoring cards don't use the cap). */
export function distinctReviewedSince(
  evidence: readonly EvidenceLike[],
  since: Date,
  now: Date,
  skip?: (e: EvidenceLike) => boolean,
): number {
  const seen = new Set<string>();
  for (const e of evidence) {
    if (!REVIEW_ANSWER_KINDS.has(e.kind)) continue;
    const t = e.at.getTime();
    if (t < since.getTime() || t > now.getTime()) continue;
    if (skip?.(e)) continue;
    seen.add(cardKey(e));
  }
  return seen.size;
}

/** Cards with a rated answer since `since` (finished or not). */
function touchedSince(evidence: readonly EvidenceLike[], since: Date, now: Date): Set<string> {
  const out = new Set<string>();
  for (const e of evidence) {
    if (!RATED_KINDS.has(e.kind)) continue;
    const t = e.at.getTime();
    if (t >= since.getTime() && t <= now.getTime()) out.add(cardKey(e));
  }
  return out;
}

/** Cards finished since `since`: answered, and the last answer wasn't Again. Learning steps are
 * done inside the session by the Again re-queue, so a finished card doesn't come back the same session. */
export function finishedSince(evidence: readonly EvidenceLike[], since: Date, now: Date): Set<string> {
  const last = new Map<string, { t: number; again: boolean }>();
  // Phase 43 Part E.2: the third Again in a session puts the card aside until the next session.
  const agains = new Map<string, number>();
  for (const e of evidence) {
    if (!RATED_KINDS.has(e.kind)) continue;
    const t = e.at.getTime();
    if (t < since.getTime() || t > now.getTime()) continue;
    const k = cardKey(e);
    if (AGAIN_KINDS.has(e.kind)) agains.set(k, (agains.get(k) ?? 0) + 1);
    const prev = last.get(k);
    if (!prev || prev.t <= t) last.set(k, { t, again: AGAIN_KINDS.has(e.kind) });
  }
  const parked = (k: string) => (agains.get(k) ?? 0) >= PROGRESS_CONFIG.againsBeforePark;
  return new Set([...last].filter(([k, v]) => !v.again || parked(k)).map(([k]) => k));
}

/** Cards that take part in sessions: every Review skill (listening is its own queue). */
const inReviewQueue = (c: SkillCard) => c.skill !== 'listening';

/** A card for a later session: not finished in this count window, or finished and moved to a time
 * still ahead (an answer that left it in a learning step parks it at the next session's start). */
const stillAhead = (c: SkillCard, finished: ReadonlySet<string>, now: Date) =>
  !finished.has(cardKey(c)) || c.card.due.getTime() > now.getTime();

/** Phase 43 Part C.1: a session as it was when its first answer was given. From then on no new card
 * or new face joins it; its cards come back until they are finished. Stored per profile (synced). */
export interface FixedSession {
  /** `windowKey` of the session ("2026-10-16:morning"). */
  key: string;
  /** When the first answer was given. */
  at: Date;
  /** Every card of the session then (`sessionCardKey`), new ones included. */
  cardKeys: string[];
  /** The new cards among them (some may have had no card yet: study-order words). */
  newKeys: string[];
}

interface SessionInput {
  cards: readonly SkillCard[];
  /** Evidence since `statusEvidenceSince(now)`, undone answers already removed (`activeEvidence`). */
  evidence: readonly EvidenceLike[];
  now: Date;
  settings?: SessionSettings;
  /** Phase 40: is this a tutoring card? (Tutoring cards go first: new words, and due cards among equals.) */
  tutor?: (c: Pick<SkillCard, 'item' | 'skill'>) => boolean;
  /** Phase 42: tutoring word id → class order (oldest class first). */
  tutorOrder?: ReadonlyMap<string, number>;
  /** Phase 43: the study order of other new items (lower first); absent: oldest card first. */
  newRank?: (c: SkillCard) => number;
  /** Phase 43 Part C.1: the session as fixed at its first answer (any session; only the matching one is used). */
  fixed?: readonly FixedSession[];
}

const DAY_MS = 86_400_000;

/** FSRS-style recall chance now (lower = more urgent); a card never answered is 1. */
export function recallChance(c: SkillCard, now: Date): number {
  const s = Math.max(0.1, c.card.stability || 0.1);
  const last = c.card.last_review ? new Date(c.card.last_review).getTime() : new Date(c.card.due).getTime() - s * DAY_MS;
  const t = Math.max(0, (now.getTime() - last) / DAY_MS);
  return Math.pow(1 + (19 / 81) * (t / s), -0.5);
}

/** A word-first card (a word's Meaning, or a grammar point): counts against the day's `words`. */
const isWordFirst = (c: Pick<SkillCard, 'item' | 'skill'>): boolean => c.item.kind === 'grammar' || c.skill === 'recognition';

/** Cards first answered on or after `since` (every in-app answer they have was given since then):
 * the day's new words and new faces. Cards the learner said they know don't count. */
function firstAnsweredSince(cards: readonly SkillCard[], evidence: readonly EvidenceLike[], since: Date, now: Date): { words: number; faces: number } {
  const rated = new Map<string, number>();
  for (const e of evidence) {
    if (!RATED_KINDS.has(e.kind) || e.at.getTime() < since.getTime() || e.at.getTime() > now.getTime()) continue;
    rated.set(cardKey(e), (rated.get(cardKey(e)) ?? 0) + 1);
  }
  let words = 0;
  let faces = 0;
  for (const c of cards) {
    if (!inReviewQueue(c) || c.flags.knownChecked || c.flags.markedKnown) continue;
    const n = inAppAnswers(c);
    if (n === 0 || n > (rated.get(cardKey(c)) ?? 0)) continue;
    if (isWordFirst(c)) words++;
    else faces++;
  }
  return { words, faces };
}

/** Phase 43 Part A: what is left of today's new words and faces, and this session's share of it. */
export interface NewToday {
  wordsLeft: number;
  facesLeft: number;
  /** This session's share (after the morning/evening split and skipped sessions). */
  sessionWords: number;
  sessionFaces: number;
  /** Two sessions in a row went undone: no new cards until this session's reviews are done. */
  paused: boolean;
}

export interface SessionPlan {
  window?: SessionWindow;
  /** The session was fixed at its first answer (Part C.1). */
  started: boolean;
  /** Answered cards in the session (most urgent first, at most the ceiling). */
  due: SkillCard[];
  /** New cards in the session (tutoring first, then the study order; Meaning before later faces). */
  fresh: SkillCard[];
  /** Fixed sessions only: new items of the session that had no card yet. */
  pendingNewKeys: string[];
  /** Answered cards due in this session that wait for the next one (over the ceiling). */
  waiting: number;
  newToday: NewToday;
}

/**
 * Phase 43 Part A/C: the session open now (with `early` between sessions, the next one). Due cards:
 * every answered card due before the session's cutoff, the most urgent first, at most the ceiling
 * (`capPerSession`); the rest wait. New cards: this session's share of the day's limits, in the room
 * left under the ceiling, tutoring words first; a later face only once the face before it was
 * released before the session opened, and never beside another card of its word. Once the session
 * has its first answer it is fixed: nothing new joins.
 */
export function planSession(input: SessionInput & { early?: boolean }): SessionPlan {
  const s = input.settings ?? DEFAULT_SESSION_SETTINGS;
  const { now } = input;
  const pos = sessionAt(now, s);
  const window = pos.current ?? (input.early ? pos.next : undefined);
  const since = countWindowStart(pos);
  const finished = finishedSince(input.evidence, since, now);
  const touched = touchedSince(input.evidence, since, now);
  const isTutor = input.tutor ?? (() => false);
  const live = input.cards.filter((c) => inReviewQueue(c) && c.state !== 'unseen' && isActiveCard(c));
  const empty: NewToday = { wordsLeft: 0, facesLeft: 0, sessionWords: 0, sessionFaces: 0, paused: false };
  if (!window) return { started: false, due: [], fresh: [], pendingNewKeys: [], waiting: 0, newToday: newTodayFor(input, s, pos.next, 0) ?? empty };

  // Answered cards this session holds: due before its cutoff (not finished in it), a Mastered card's
  // re-check, and cards answered Again in it that are not finished (or parked).
  const keep = pos.current ? (c: SkillCard) => !finished.has(cardKey(c)) : (c: SkillCard) => stillAhead(c, finished, now);
  const candidates = live.filter(
    (c) =>
      !isNewCard(c) &&
      ((isDueBefore(c, window.cutoff) && keep(c)) ||
        (recheckDue(c, now) && !finished.has(cardKey(c))) ||
        (touched.has(cardKey(c)) && !finished.has(cardKey(c)))),
  );
  const fixed = input.fixed?.find((f) => f.key === windowKey(window));
  if (fixed) {
    const keys = new Set(fixed.cardKeys);
    const newKeys = new Set(fixed.newKeys);
    const mine = live.filter((c) => keys.has(cardKey(c)) && !finished.has(cardKey(c)));
    const carded = new Set(input.cards.filter((c) => c.state !== 'unseen').map(cardKey));
    const due = mine.filter((c) => !isNewCard(c) && !newKeys.has(cardKey(c)));
    const fresh = mine.filter((c) => !due.includes(c));
    const answered = new Set([...touched, ...finished]);
    return {
      window,
      started: true,
      due,
      fresh,
      pendingNewKeys: fixed.newKeys.filter((k) => !carded.has(k) && !answered.has(k)),
      waiting: candidates.filter((c) => !keys.has(cardKey(c))).length,
      newToday: { ...(newTodayFor(input, s, window, candidates.length) ?? empty), sessionWords: 0, sessionFaces: 0 },
    };
  }

  // A session with Review answers in it already (on another device, before its fixed copy synced)
  // is started too: new cards never join it partway through.
  const answeredHere =
    !!pos.current &&
    input.evidence.some((e) => REVIEW_ANSWER_KINDS.has(e.kind) && !practised(e) && e.at.getTime() >= since.getTime() && e.at.getTime() <= now.getTime());
  const ceiling = s.capPerSession;
  const tutorFirst = (c: SkillCard) => (isTutor(c) ? 0 : 1);
  const ranked = candidates
    .map((c) => ({ c, started: touched.has(cardKey(c)) ? 0 : 1, r: Math.round(recallChance(c, now) * 100) }))
    .sort(
      (a, b) =>
        a.started - b.started || a.r - b.r || tutorFirst(a.c) - tutorFirst(b.c) || a.c.card.due.getTime() - b.c.card.due.getTime(),
    )
    .map((x) => x.c);
  const due = ranked.slice(0, ceiling);
  const waiting = ranked.length - due.length;
  const newToday = newTodayFor(input, s, window, ranked.length) ?? empty;

  let room = Math.max(0, ceiling - due.length);
  const order = (c: SkillCard) =>
    isTutor(c) ? -1e9 + (input.tutorOrder?.get(c.item.id) ?? 1e6) : (input.newRank?.(c) ?? 0);
  const byOrder = (a: SkillCard, b: SkillCard) =>
    order(a) - order(b) || new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime() || cardKey(a).localeCompare(cardKey(b));
  const newCards = live.filter((c) => isNewCard(c));
  const words = newCards
    .filter(isWordFirst)
    .sort(byOrder)
    .slice(0, answeredHere ? 0 : Math.min(newToday.sessionWords, room));
  room -= words.length;
  const released = releasedFaceKeys(input.cards, since);
  const busy = new Set([...due, ...words].map((c) => `${c.item.kind}:${c.item.id}`));
  const faces: SkillCard[] = [];
  for (const c of newCards.filter((x) => !isWordFirst(x)).sort((a, b) => faceStage(a) - faceStage(b) || byOrder(a, b))) {
    if (answeredHere || faces.length >= Math.min(newToday.sessionFaces, room)) break;
    const k = `${c.item.kind}:${c.item.id}`;
    if (busy.has(k) || !faceGateOpen(c, released)) continue;
    busy.add(k);
    faces.push(c);
  }
  return {
    window,
    started: answeredHere,
    due,
    fresh: [...words, ...faces],
    pendingNewKeys: [],
    waiting,
    newToday: {
      ...newToday,
      // what is left of the session's share for study-order words with no card yet
      sessionWords: answeredHere ? 0 : Math.max(0, Math.min(newToday.sessionWords - words.length, room)),
      sessionFaces: answeredHere ? 0 : Math.max(0, newToday.sessionFaces - faces.length),
    },
  };
}

/** Did anyone answer in this session, or was it nothing to do? A session is "undone" when nobody
 * answered in it and cards it held are still waiting. */
function undone(w: SessionWindow, evidence: readonly EvidenceLike[], cards: readonly SkillCard[], now: Date): boolean {
  const answered = evidence.some((e) => RATED_KINDS.has(e.kind) && !practised(e) && e.at >= w.opensAt && e.at < w.endsAt);
  if (answered) return false;
  return cards.some((c) => inReviewQueue(c) && isActiveCard(c) && isDueBefore(c, w.cutoff) && c.card.due.getTime() <= now.getTime());
}

/** Phase 43 Part A.4 / C.2: today's limits left and this session's share. */
function newTodayFor(input: SessionInput, s: SessionSettings, window: SessionWindow, dueInSession: number): NewToday | undefined {
  const windows = sessionWindows(input.now, s, 2);
  const i = windows.findIndex((w) => windowKey(w) === windowKey(window));
  if (i < 0) return undefined;
  const morning = windows.find((w) => w.day === window.day && w.name === 'morning')!;
  const used = firstAnsweredSince(input.cards, input.evidence, morning.opensAt, input.now);
  const limit = { words: s.newWordsPerDay, faces: s.newFacesPerDay };
  const wordsLeft = Math.max(0, limit.words - used.words);
  const facesLeft = Math.max(0, limit.faces - used.faces);
  const half = (n: number) => Math.ceil(n * PROGRESS_CONFIG.morningNewShare);
  const prev = windows[i - 1];
  const prev2 = windows[i - 2];
  const prevUndone = !!prev && prev.endsAt.getTime() <= input.now.getTime() && undone(prev, input.evidence, input.cards, input.now);
  const paused = prevUndone && !!prev2 && undone(prev2, input.evidence, input.cards, input.now) && dueInSession > 0;
  let sessionWords: number;
  let sessionFaces: number;
  if (window.name === 'morning') {
    sessionWords = Math.min(wordsLeft, Math.max(0, half(limit.words) - used.words));
    sessionFaces = Math.min(facesLeft, Math.max(0, half(limit.faces) - used.faces));
  } else if (prevUndone && prev?.name === 'morning') {
    // a skipped morning's share is never made: the evening gets only its own
    sessionWords = Math.min(wordsLeft, limit.words - half(limit.words));
    sessionFaces = Math.min(facesLeft, limit.faces - half(limit.faces));
  } else {
    sessionWords = wordsLeft;
    sessionFaces = facesLeft;
  }
  if (paused) {
    sessionWords = 0;
    sessionFaces = 0;
  }
  return { wordsLeft, facesLeft, sessionWords, sessionFaces, paused };
}

/** The cards of the session open now (with `early` between sessions, the next session's): its due
 * cards and its new cards. Empty between sessions otherwise. */
export function sessionCards(input: SessionInput & { early?: boolean }): { cards: SkillCard[]; window?: SessionWindow } {
  const p = planSession(input);
  return { cards: [...p.fresh, ...p.due], ...(p.window ? { window: p.window } : {}) };
}

/**
 * Part A: this session's cards, the next session, what's done, and what new words may do. `cards`
 * is every card (listening cards are ignored: they are their own queue).
 */
export function reviewStatus(input: SessionInput & { plan?: SessionPlan }): ReviewStatus {
  const { now } = input;
  const s = input.settings ?? DEFAULT_SESSION_SETTINGS;
  const cap = s.capPerSession;
  const pos = sessionAt(now, s);
  const since = countWindowStart(pos);
  const finished = finishedSince(input.evidence, since, now);
  const plan = input.plan ?? planSession(input);
  const current = pos.current;
  const inCurrent = current ? [...plan.fresh, ...plan.due] : [];
  const isTutor = input.tutor ?? (() => false);
  const tutorCount = inCurrent.filter((c) => isTutor(c)).length;
  const thirsty = new Set(inCurrent.filter((c) => c.item.kind === 'word').map((c) => c.item.id));
  const currentKeys = new Set(inCurrent.map(cardKey));
  const nextPlan = current ? undefined : plan.window ? plan : planSession({ ...input, early: true });
  const inNext = current
    ? input.cards.filter(
        (c) =>
          inReviewQueue(c) &&
          isActiveCard(c) &&
          stillAhead(c, finished, now) &&
          isDueBefore(c, pos.next.cutoff) &&
          !currentKeys.has(cardKey(c)) &&
          !isDueBefore(c, current.cutoff),
      )
    : [...(nextPlan?.fresh ?? []), ...(nextPlan?.due ?? [])];
  // cards over this session's ceiling wait for the next one
  const nextCount = current ? Math.min(cap, inNext.length + plan.waiting) : inNext.length;
  const left = current
    ? 0
    : input.cards.filter((c) => inReviewQueue(c) && isActiveCard(c) && !finished.has(cardKey(c)) && isDueBefore(c, pos.previous.endsAt)).length;
  // Phase 45: a practice answer is done in this session only for a card the (fixed) session holds.
  const fixedNow = current ? input.fixed?.find((f) => f.key === windowKey(current)) : undefined;
  const sessionKeys = new Set([...(fixedNow?.cardKeys ?? []), ...currentKeys]);
  const doneThisSession = distinctReviewedSince(input.evidence, since, now, (e) => practised(e) && !sessionKeys.has(cardKey(e)));
  const capLeft = Math.max(0, cap - doneThisSession);
  const nt = plan.newToday;
  const newState: NewState = !current
    ? 'open'
    : nt.paused
      ? 'paused_backlog'
      : plan.started || (nt.wordsLeft === 0 && nt.facesLeft === 0)
        ? 'limit_reached'
        : 'open';
  const newMessage =
    newState === 'paused_backlog'
      ? newStateMessage('paused_backlog', cap)
      : newState === 'limit_reached'
        ? plan.started
          ? 'New words join at the start of a session, never partway through.'
          : "Today's new words are all in. More tomorrow."
        : undefined;
  return {
    session: current ? current.name : 'between',
    sessionCards: inCurrent.length,
    dueNow: inCurrent.length,
    ...(current ? { sessionEndsAt: current.endsAt } : {}),
    nextSession: { name: pos.next.name, opensAt: pos.next.opensAt, count: nextCount },
    previousSession: { name: pos.previous.name, left },
    doneThisSession,
    cap,
    capLeft,
    reviewAll: inCurrent.length,
    thirstyWords: thirsty.size,
    thirstyWordIds: [...thirsty],
    sessionCardKeys: inCurrent.map(cardKey),
    tutorCards: tutorCount,
    nextSessionCardKeys: inNext.map(cardKey),
    nextSessionWordIds: [...new Set(inNext.filter((c) => c.item.kind === 'word').map((c) => c.item.id))],
    newState,
    ...(newMessage ? { newMessage } : {}),
    // between sessions: what the next session would offer (other screens' candidate words)
    newAllowed: current ? nt.sessionWords : (nextPlan?.newToday.sessionWords ?? 0),
    waiting: current ? plan.waiting : 0,
    started: plan.started,
    newCards: current ? plan.fresh.length : 0,
    newToday: { wordsLeft: nt.wordsLeft, facesLeft: nt.facesLeft },
    timeZone: s.timeZone,
  };
}

export interface ForecastDay {
  /** Local day "YYYY-MM-DD" in the profile's zone. */
  day: string;
  morning: number;
  evening: number;
}

/**
 * The 7-day forecast: two bars a day, morning and evening, each the cards that session will hold
 * (the current session's left-overs included). Day 0 is the day of the session open now, or the
 * next one.
 */
export function sessionForecast(input: SessionInput & { days?: number }): ForecastDay[] {
  const s = input.settings ?? DEFAULT_SESSION_SETTINGS;
  const days = input.days ?? 7;
  const { now } = input;
  const windows = sessionWindows(now, s, days + 1);
  const pos = sessionAt(now, s);
  const first = pos.current ?? pos.next;
  const startIdx = windows.findIndex((w) => w.day === first.day);
  const dayNames = [...new Set(windows.slice(startIdx).map((w) => w.day))].slice(0, days);
  const out: ForecastDay[] = dayNames.map((day) => ({ day, morning: 0, evening: 0 }));
  const at = new Map(dayNames.map((d, i) => [d, i]));
  const finished = finishedSince(input.evidence, countWindowStart(pos), now);
  for (const c of input.cards) {
    if (!inReviewQueue(c) || !stillAhead(c, finished, now)) continue;
    if (!isScheduledCard(c)) continue;
    const w = sessionForDue(c.card.due, now, windows);
    const i = w ? at.get(w.day) : undefined;
    if (w && i !== undefined) out[i]![w.name]++;
  }
  // Phase 43 Part C.3: a session holds at most the ceiling; the rest roll into the next one.
  let carry = 0;
  for (const d of out)
    for (const k of ['morning', 'evening'] as const) {
      const total = d[k] + carry;
      d[k] = Math.min(s.capPerSession, total);
      carry = total - d[k];
    }
  return out;
}
