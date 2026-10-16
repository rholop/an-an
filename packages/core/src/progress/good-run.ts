// Phase 43 Part B (owner, 2026-10-16: "until the first kind of cards are being marked consistently
// good and easy the next kind WILL NOT show up in the same session"): a word's next face is released
// once the face before it was rated Good or Easy `faceReleaseGoodRuns` times in a row, each time in a
// different review session. Again or Hard resets the run. A face released during a session enters
// from the next session on. Pure; time is passed in.

import { Rating } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { PROGRESS_CONFIG } from './progress.config.js';
import { DEFAULT_SESSION_SETTINGS, sessionKeyAt, type SessionSettings } from './review-sessions.js';
import { isLearnedCard } from './terms.js';

type RunFlags = Pick<SkillCard['flags'], 'goodRun' | 'goodRunSession' | 'faceReleasedAt'>;
type RunCard = Pick<SkillCard, 'flags'>;

const need = (): number => PROGRESS_CONFIG.faceReleaseGoodRuns;

/**
 * The run after one rating. `grade` Good/Easy in a session other than the last counted one adds one
 * (a second Good in the same session leaves it); Again/Hard resets it. `sessionKey` names the session.
 */
export function nextGoodRun(c: RunCard | undefined, grade: Rating, at: Date, sessionKey: string): RunFlags {
  const run = c?.flags.goodRun ?? 0;
  if (grade !== Rating.Good && grade !== Rating.Easy) return { goodRun: 0 };
  const released = c?.flags.faceReleasedAt;
  if (c?.flags.goodRunSession === sessionKey && run > 0)
    return { goodRun: run, goodRunSession: sessionKey, ...(released ? { faceReleasedAt: released } : {}) };
  const goodRun = run + 1;
  return {
    goodRun,
    goodRunSession: sessionKey,
    ...(released ? { faceReleasedAt: released } : goodRun >= need() ? { faceReleasedAt: at } : {}),
  };
}

/** The session key of an answer: the one the app sent, else the default sessions'. */
export function answerSessionKey(at: Date, given?: string, s: SessionSettings = DEFAULT_SESSION_SETTINGS): string {
  return given ?? sessionKeyAt(at, s);
}

/** This face is consistently known (it releases the word's next face). A card from before Phase 43
 * that the migration never reached counts when it is Learned and not rated "Not yet". */
export function faceReleased(c: Pick<SkillCard, 'flags' | 'state' | 'card'>): boolean {
  if (c.flags.goodRun !== undefined) return c.flags.goodRun >= need();
  return isLearnedCard(c) && c.flags.knownFace !== false;
}

/** Released before `t` (so the next face may be in a session that opened at `t`). */
export function faceReleasedBefore(c: Pick<SkillCard, 'flags' | 'state' | 'card'>, t: Date): boolean {
  if (!faceReleased(c)) return false;
  const at = c.flags.faceReleasedAt;
  return !at || new Date(at).getTime() < t.getTime();
}

/** One rated answer of the history the migration replays. */
export interface RunAnswer {
  key: string;
  at: Date;
  grade: Rating;
  /** Rate your words: Not yet (resets) or Good/Easy (one rating). */
  rating?: 'not_yet';
}

/**
 * Phase 43 Part B.4 migration: each card's run from its answers so far (oldest first), so a card
 * rated Good once under Phase 42 is not treated as released.
 */
export function goodRunsFromHistory(answers: readonly RunAnswer[], s: SessionSettings = DEFAULT_SESSION_SETTINGS): Map<string, RunFlags> {
  const out = new Map<string, RunFlags>();
  for (const a of [...answers].sort((x, y) => x.at.getTime() - y.at.getTime())) {
    const prev = out.get(a.key);
    const card = prev ? { flags: prev } : undefined;
    out.set(a.key, a.rating === 'not_yet' ? { goodRun: 0 } : nextGoodRun(card, a.grade, a.at, sessionKeyAt(a.at, s)));
  }
  return out;
}
