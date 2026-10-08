import type { AnnotatedToken } from '../components/AnnotatedText.js';
import { db, learnerService } from '../db/instance.js';
import { markClip } from './audio.js';
import { reportGloss, withdrawGlossReport } from './gloss-reports.js';
import { REPORT_THANKS } from './labels.js';
import { showToast } from './toast.js';

/**
 * Phase 21 Part H: "⚑ Something's wrong" on a definition, the same everywhere (popovers in every
 * tab): saved for review (Reported page → Definitions), confirmed with the app's one toast, Undo.
 */
export async function reportDefinition(at: AnnotatedToken, contextSentence: string): Promise<void> {
  if (!at.word) return;
  const id = await reportGloss(db, {
    word: at.word,
    ...(at.sense ? { sense: at.sense } : {}),
    shownGloss: at.gloss,
    contextSentence,
  });
  showToast(`${REPORT_THANKS} "${at.token.text}" is on the Reported page.`, () => withdrawGlossReport(db, id));
}

/**
 * Phase 21 Part I: what a popover records when the page gives no handler of its own (Textbook,
 * Journal, Garden, Progress, chips, recasts …): a lookup is a lookup wherever it happens.
 */
export async function recordDefaultLookup(
  at: AnnotatedToken,
  kind: 'gloss' | 'reading',
  source: 'reader' | 'textbook' | 'journal' | 'chat' | 'cloze' | 'review' = 'reader',
): Promise<void> {
  if (!at.wordId) return;
  const now = new Date();
  await learnerService.record(
    {
      item: { kind: 'word', id: at.wordId },
      skill: 'recognition',
      kind: kind === 'gloss' ? 'chat_lookup_gloss' : 'chat_hover_reading',
      at: now,
      context: { source },
    },
    now,
  );
}

/**
 * Phase 21 Part H: "⚑ Something's wrong" on an audio clip (speaker buttons and Listen), with Undo.
 * The flag is sent once the Undo window has passed, since a sent flag can't be taken back; until
 * then `hidden` lets the caller stop offering the clip.
 */
export function reportClip(args: Parameters<typeof markClip>[0], onUndo?: () => void, ms = 6500): void {
  let undone = false;
  setTimeout(() => {
    if (!undone) void markClip(args);
  }, ms);
  showToast(`${REPORT_THANKS} That clip won't play again.`, () => {
    undone = true;
    onUndo?.();
  });
}
