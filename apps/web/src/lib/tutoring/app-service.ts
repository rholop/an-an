// Phase 39: the Tutoring screen's service, the draft waiting for Save, and "open this class".
import type { Lexicon } from '@anan/core';
import { db } from '../../db/instance.js';
import { getLedgerNow } from '../ledger.js';
import { reloadTutorLessons } from '../study.js';
import { FetchTutorLLM } from '../tutor-llm.js';
import { ensureTutorCards } from './introduce.js';
import { loadTaiwanConverters } from '../opencc.js';
import { TutoringService, type DraftResult } from './tutoring-service.js';

export function appTutoringService(lexicon: Lexicon): TutoringService {
  return new TutoringService(db, lexicon, new FetchTutorLLM(), (now) => getLedgerNow(now), loadTaiwanConverters, async (now) => {
    // the study order must see the class just saved before its words are introduced
    await reloadTutorLessons();
    return ensureTutorCards(now);
  });
}

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
