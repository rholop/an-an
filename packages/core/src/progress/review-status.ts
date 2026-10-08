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
  zonedDay,
  type SessionName,
  type SessionSettings,
  type SessionWindow,
} from './review-sessions.js';
import { isDueBefore, isScheduledCard } from './terms.js';

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

type EvidenceLike = Pick<Evidence, 'item' | 'skill' | 'kind' | 'at'>;

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
  /** "Review all (N)": this session's cards that fit under the cap. */
  reviewAll: number;
  /** "Water all (N)": distinct words with a card in this session. */
  thirstyWords: number;
  thirstyWordIds: string[];
  /** New words this session. */
  newState: NewState;
  newMessage?: string;
  newAllowed: number;
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

/** Local midnight after `now` (the end of "today", in the runtime's zone). */
export function endOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

const cardKey = (c: Pick<SkillCard, 'item' | 'skill'>) => `${c.item.kind}:${c.item.id}|${c.skill}`;

/** Distinct cards answered in Review between `since` and `now` (from already-active evidence). */
export function distinctReviewedSince(evidence: readonly EvidenceLike[], since: Date, now: Date): number {
  const seen = new Set<string>();
  for (const e of evidence) {
    if (!REVIEW_ANSWER_KINDS.has(e.kind)) continue;
    const t = e.at.getTime();
    if (t < since.getTime() || t > now.getTime()) continue;
    seen.add(cardKey(e));
  }
  return seen.size;
}

/** Distinct cards answered in Review today (local midnight of the runtime's zone). */
export function distinctReviewedToday(evidence: readonly EvidenceLike[], now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return distinctReviewedSince(evidence, start, now);
}

/** Cards finished since `since`: answered, and the last answer wasn't Again. Learning steps are
 * done inside the session by the Again re-queue, so a finished card doesn't come back the same session. */
export function finishedSince(evidence: readonly EvidenceLike[], since: Date, now: Date): Set<string> {
  const last = new Map<string, { t: number; again: boolean }>();
  for (const e of evidence) {
    if (!RATED_KINDS.has(e.kind)) continue;
    const t = e.at.getTime();
    if (t < since.getTime() || t > now.getTime()) continue;
    const k = cardKey(e);
    const prev = last.get(k);
    if (!prev || prev.t <= t) last.set(k, { t, again: AGAIN_KINDS.has(e.kind) });
  }
  return new Set([...last].filter(([, v]) => !v.again).map(([k]) => k));
}

/** Cards that take part in sessions: every Review skill (listening is its own queue). */
const inReviewQueue = (c: SkillCard) => c.skill !== 'listening';

interface SessionInput {
  cards: readonly SkillCard[];
  /** Evidence since `statusEvidenceSince(now)`, undone answers already removed (`activeEvidence`). */
  evidence: readonly EvidenceLike[];
  now: Date;
  settings?: SessionSettings;
}

/**
 * The cards of the session open now (every card due before its cutoff that wasn't finished in it),
 * or with `early` between sessions, the next session's. Empty between sessions otherwise.
 */
export function sessionCards(input: SessionInput & { early?: boolean }): { cards: SkillCard[]; window?: SessionWindow } {
  const s = input.settings ?? DEFAULT_SESSION_SETTINGS;
  const pos = sessionAt(input.now, s);
  const window = pos.current ?? (input.early ? pos.next : undefined);
  if (!window) return { cards: [] };
  const finished = finishedSince(input.evidence, countWindowStart(pos), input.now);
  const cards = input.cards.filter(
    (c) => inReviewQueue(c) && isDueBefore(c, window.cutoff) && !finished.has(cardKey(c)),
  );
  return { cards, window };
}

/**
 * Part A: this session's cards, the next session, what's done and left under the cap, and what
 * new words may do. `cards` is every card (listening cards are ignored: they are their own queue).
 */
export function reviewStatus(
  input: SessionInput & {
    /** Cards per session at most (the session cap). Defaults to the settings' cap. */
    cap?: number;
    /** New items a session adds when nothing holds them back. */
    baseNew?: number;
    newHalfShare?: number;
  },
): ReviewStatus {
  const { now } = input;
  const s = input.settings ?? DEFAULT_SESSION_SETTINGS;
  const cap = input.cap ?? s.capPerSession;
  const pos = sessionAt(now, s);
  const since = countWindowStart(pos);
  const finished = finishedSince(input.evidence, since, now);
  const live = input.cards.filter((c) => inReviewQueue(c) && !finished.has(cardKey(c)));

  const current = pos.current;
  const inCurrent = current ? live.filter((c) => isDueBefore(c, current.cutoff)) : [];
  const thirsty = new Set(inCurrent.filter((c) => c.item.kind === 'word').map((c) => c.item.id));
  const nextCount = live.filter(
    (c) => isDueBefore(c, pos.next.cutoff) && !(current && isDueBefore(c, current.cutoff)),
  ).length;
  const left = live.filter((c) => isDueBefore(c, pos.previous.endsAt)).length;

  const doneThisSession = distinctReviewedSince(input.evidence, since, now);
  const capLeft = Math.max(0, cap - doneThisSession);
  const n = newWordState({
    dueNow: inCurrent.length,
    capLeft,
    cap,
    baseNew: input.baseNew ?? 0,
    newHalfShare: input.newHalfShare ?? REVIEW_PILE_CONFIG.newHalfShare,
  });
  return {
    session: current ? current.name : 'between',
    sessionCards: inCurrent.length,
    dueNow: inCurrent.length,
    ...(current ? { sessionEndsAt: current.endsAt } : {}),
    nextSession: { name: pos.next.name, opensAt: pos.next.opensAt, count: nextCount },
    previousSession: { name: pos.previous.name, left: current ? 0 : left },
    doneThisSession,
    cap,
    capLeft,
    reviewAll: Math.min(inCurrent.length, capLeft),
    thirstyWords: thirsty.size,
    thirstyWordIds: [...thirsty],
    ...n,
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
    if (!inReviewQueue(c) || finished.has(cardKey(c))) continue;
    if (!isScheduledCard(c)) continue;
    const w = sessionForDue(c.card.due, now, windows);
    const i = w ? at.get(w.day) : undefined;
    if (w && i !== undefined) out[i]![w.name]++;
  }
  return out;
}

/** "YYYY-MM-DD" of `now` in the settings' zone (labels compare forecast days to it). */
export const todayIn = (now: Date, s: SessionSettings = DEFAULT_SESSION_SETTINGS): string => zonedDay(now, s.timeZone);
