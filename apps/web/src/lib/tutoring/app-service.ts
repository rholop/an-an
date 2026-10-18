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
import { loadTextbookSentences } from '../textbook-data.js';
import { practiceBank } from '../grammar-practice.js';
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
    // Phase 46: the sources a grammar point's practice sentences come from
    practiceSources: async () => {
      const [textbook, bank] = await Promise.all([loadTextbookSentences(), practiceBank()]);
      return { textbook, bank };
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

/**
 * Phase 46 Parts C.2 and D.5: classes saved before Phase 46 get their grammar text in Taiwan
 * characters and their matches re-checked, once per profile.
 */
export const TUTOR_GRAMMAR_MIGRATION_KEY = 'tutorGrammarConvertedAt';
const grammarMigrated = new WeakSet<object>();
export async function migrateTutorGrammarOnce(lexicon: Lexicon, now: Date = new Date()): Promise<void> {
  if (grammarMigrated.has(lexicon)) return;
  grammarMigrated.add(lexicon);
  if (await db.settings.get(TUTOR_GRAMMAR_MIGRATION_KEY)) return;
  if ((await db.tutorSessions.count()) > 0) await appTutoringService(lexicon).migrateGrammar(now);
  await db.settings.put({ key: TUTOR_GRAMMAR_MIGRATION_KEY, value: now.toISOString() });
}
