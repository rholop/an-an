// Phase 39 (owner, 2026-10-13): tutoring words are added as soon as a class is saved: New cards that
// lead the next review session, outside the new-word allowance. An upload over the per-session limit
// (20) introduces the rest first thing in the following sessions, when Review opens.
import { tutorIntroduceEvidence, type Evidence, type Ledger } from '@anan/core';
import { learnerService } from '../../db/instance.js';

export interface IntroduceDeps {
  ledger: (now: Date) => Promise<Ledger>;
  recordBulk: (e: Evidence[], now: Date) => Promise<unknown>;
}

const appDeps: IntroduceDeps = {
  ledger: (n) => learnerService.ledger(n),
  recordBulk: (e, n) => learnerService.recordBulk(e, n),
};

/** Introduces the tutoring words the ledger says are due to join now. Returns how many. */
export async function ensureTutorCards(now: Date = new Date(), deps: IntroduceDeps = appDeps): Promise<number> {
  const events = tutorIntroduceEvidence((await deps.ledger(now)).tutorToIntroduce(), now);
  if (events.length > 0) await deps.recordBulk(events, now);
  return events.length;
}
