// Phase 39 / 40 (owner, 2026-10-14: "I want them added instantly to my review"): a saved class's
// ticked words are introduced at once with every face (Meaning, Pick then Recall, Say it): New cards
// that are in the review session straight away, whatever the time of day, outside the cap and the
// new-word allowance. No per-session limit. Faces a word is still missing (a class saved before
// Phase 40) are added the next time this runs (Save, Review, the class page).
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

/** Introduces the tutoring words' missing faces the ledger lists. Returns how many words. */
export async function ensureTutorCards(now: Date = new Date(), deps: IntroduceDeps = appDeps): Promise<number> {
  const list = (await deps.ledger(now)).tutorToIntroduce();
  const events = tutorIntroduceEvidence(list, now);
  if (events.length > 0) await deps.recordBulk(events, now);
  return list.length;
}
