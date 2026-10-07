import { lessonIndex, shouldWake, type Lexicon, type NopeChoice } from '@anan/core';
import { db, learnerService } from '../db/instance.js';
import { peekCurrentLevel } from './current-level.js';
import { getStudyBooks, getStudyFocusNow } from './study.js';

/** Phase 20: the labels the learner sees for each Nope choice. */
export const NOPE_LABELS: Record<NopeChoice, string> = {
  not_now: 'Not now',
  known: 'I already know it',
  never: 'Never show this',
};

/** Where the learner is right now (a "Not now" word comes back when this moves to the word's own). */
export async function nopeSnapshot(now: Date = new Date()): Promise<{ level?: ReturnType<typeof peekCurrentLevel>['level']; lessonId?: string }> {
  const focus = await getStudyFocusNow(now).catch(() => undefined);
  const lessonId = focus?.enabled && focus.activeStep?.kind === 'lesson' ? focus.activeStep.lessonId : undefined;
  return { level: peekCurrentLevel().level, ...(lessonId ? { lessonId } : {}) };
}

/** Say "nope" to a word: every skill, with the learner's position remembered for "Not now". */
export async function nopeWord(wordOrItem: { kind: 'word' | 'grammar'; id: string }, choice: NopeChoice, now: Date = new Date()) {
  const snoozedWhen = choice === 'not_now' ? await nopeSnapshot(now) : undefined;
  return learnerService.nope(wordOrItem, choice, snoozedWhen ? { snoozedWhen } : {}, now);
}

/**
 * "Not now" words whose level became the picked level, or whose lesson became the active study
 * step, come back into review. Returns how many words woke.
 */
export async function wakeSnoozed(lexicon: Lexicon, now: Date = new Date()): Promise<number> {
  const snoozed = (await db.items.toArray()).filter((r) => r.flags.snoozed);
  if (snoozed.length === 0) return 0;
  const here = await nopeSnapshot(now);
  const lessonOf = lessonIndex(getStudyBooks());
  const woke = new Set<string>();
  for (const r of snoozed) {
    if (woke.has(r.item.id)) continue;
    const w = r.item.kind === 'word' ? lexicon.byId(r.item.id) : undefined;
    const word = { level: w?.level ?? null, lessonId: lessonOf.get(`${r.item.kind}:${r.item.id}`) };
    if (shouldWake(r, word, { level: here.level, activeLessonId: here.lessonId })) {
      woke.add(r.item.id);
      await learnerService.restore(r.item, now);
    }
  }
  return woke.size;
}
