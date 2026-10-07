import {
  cleanupGroupWordIds,
  isActiveCard,
  type CleanupGroup,
  type ItemRef,
  type Level,
  type NopeChoice,
  type PileReport,
  type SkillCard,
} from '@anan/core';
import type { LearnerService, NopeHandle } from './learner-service.js';

/** Phase 20 Part D: what a clean-up action would remove (count + up to 10 sample words). */
export function cleanupPreview(report: PileReport, group: CleanupGroup): { ids: string[]; sample: string[] } {
  const ids = cleanupGroupWordIds(report, group);
  const headword = new Map(report.rows.map((r) => [r.item.id, r.headword]));
  return { ids, sample: ids.slice(0, 10).map((id) => headword.get(id) ?? id) };
}

/** Says "nope" to every word in `ids` (default Not now). `undo` puts every card back exactly. */
export async function applyCleanup(
  service: Pick<LearnerService, 'nope'>,
  ids: readonly string[],
  opts: { choice?: NopeChoice; snoozedWhen?: { level?: Level; lessonId?: string } } = {},
  now: Date = new Date(),
): Promise<{ count: number; undo: () => Promise<void> }> {
  const handles: NopeHandle[] = [];
  for (const id of ids) {
    handles.push(
      await service.nope({ kind: 'word', id }, opts.choice ?? 'not_now', opts.snoozedWhen ? { snoozedWhen: opts.snoozedWhen } : {}, now),
    );
  }
  return {
    count: handles.length,
    undo: async () => {
      for (const h of handles.reverse()) await h.undo();
    },
  };
}

export interface RemovedWord {
  item: ItemRef;
  choice: NopeChoice;
  /** When it was removed (the card's last change). */
  at: Date;
}

/** Every word marked Not now, I already know it, or Never show (one row per word). */
export function removedWords(cards: readonly SkillCard[]): RemovedWord[] {
  const out = new Map<string, RemovedWord>();
  for (const c of cards) {
    const choice: NopeChoice | undefined = c.flags.excluded
      ? 'never'
      : c.flags.snoozed
        ? 'not_now'
        : c.flags.markedKnown
          ? 'known'
          : undefined;
    if (!choice) continue;
    const k = `${c.item.kind}:${c.item.id}`;
    const prev = out.get(k);
    // "Never" beats "Not now" beats "Known" if a word's cards disagree.
    const order: NopeChoice[] = ['never', 'not_now', 'known'];
    if (!prev || order.indexOf(choice) < order.indexOf(prev.choice))
      out.set(k, { item: c.item, choice, at: new Date(c.updatedAt) });
  }
  return [...out.values()].sort((a, b) => b.at.getTime() - a.at.getTime());
}

export const activeCards = (cards: readonly SkillCard[]): SkillCard[] => cards.filter(isActiveCard);
