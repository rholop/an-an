// Phase 39: the Tutoring screen's service, the draft waiting for Save, and "open this class".
import type { Lexicon } from '@anan/core';
import { db } from '../../db/instance.js';
import { getLedgerNow } from '../ledger.js';
import { reloadTutorLessons } from '../study.js';
import { FetchTutorLLM } from '../tutor-llm.js';
import { ensureTutorCards } from './introduce.js';
import { loadTaiwanConverters } from '../opencc.js';
import { getActiveProfileForApi } from '../api.js';
import { readSetting } from '../useSetting.js';
import { requestTutorAudio } from './tutor-audio.js';
import { TutoringService, type DraftResult } from './tutoring-service.js';

export function appTutoringService(lexicon: Lexicon): TutoringService {
  return new TutoringService(db, lexicon, new FetchTutorLLM(), (now) => getLedgerNow(now), loadTaiwanConverters, async (now) => {
    // the study order must see the class just saved before its words are introduced
    await reloadTutorLessons();
    return ensureTutorCards(now);
  }, {
    // Phase 40 Part B: "This tutor is from Taiwan" is on unless the learner turned it off for them
    tutorFromTaiwan: async (tutor) => !(await readSetting<string[]>(NOT_FROM_TAIWAN_KEY, [])).includes(tutor.trim().toLowerCase()),
    audio: async (rec) => {
      const profileId = getActiveProfileForApi();
      if (!profileId) return undefined;
      const res = await requestTutorAudio({ ...rec, words: rec.words.filter((w) => w.ticked) }, profileId);
      const status = res.status === 'speech_not_configured' ? 'waiting_key' : res.status;
      return { status, at: new Date(), made: res.made + res.unchanged };
    },
  });
}

/** Settings key: the tutors (lowercase names) the learner said are not from Taiwan (Phase 40 Part B). */
export const NOT_FROM_TAIWAN_KEY = 'tutorsNotFromTaiwan';

// The draft waits here until Save or Discard (Part A.3): leaving the screen doesn't lose it, a reload
// does (nothing is stored before Save).
let pendingDraft: DraftResult | undefined;
export const getPendingDraft = (): DraftResult | undefined => pendingDraft;
export const setPendingDraft = (d: DraftResult | undefined): void => {
  pendingDraft = d;
};

// The Textbook page's Tutoring section opens a class on the Tutoring screen.
let pendingOpen: string | undefined;
export function openTutorClass(id?: string): void {
  pendingOpen = id;
  window.dispatchEvent(new CustomEvent('anan:go', { detail: { route: 'tutoring' } }));
}
export function takePendingTutorClass(): string | undefined {
  const id = pendingOpen;
  pendingOpen = undefined;
  return id;
}

/**
 * Phase 40 Part A.4: classes saved before Phase 40 get their levels and topics once per profile
 * (the same work as Settings → Tutoring → "Re-check levels and topics"; idempotent anyway).
 */
export const TUTOR_RECHECK_KEY = 'tutorLevelsCheckedAt';
const migrated = new WeakSet<object>();
export async function migrateTutorLevelsOnce(lexicon: Lexicon, now: Date = new Date()): Promise<void> {
  if (migrated.has(lexicon)) return;
  migrated.add(lexicon);
  if (await db.settings.get(TUTOR_RECHECK_KEY)) return;
  if ((await db.tutorSessions.count()) === 0) return; // nothing to fix; a class saved later is done at Save
  await appTutoringService(lexicon).recheckLevelsAndTopics(now);
  await db.settings.put({ key: TUTOR_RECHECK_KEY, value: now.toISOString() });
}
