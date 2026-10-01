import type { Evidence, ItemRef } from '../types.js';
import type { JournalIssue, UsedWell } from './types.js';

export interface JournalEvidenceInput {
  entryId: string;
  now: Date;
  usedWell: readonly UsedWell[];
  /** Word ids from the daily prompt that appear in the text. */
  promptWordsUsed: readonly string[];
  /** Non-flagged issues only (flagged corrections don't teach anything). */
  issues: readonly { issue: JournalIssue; selfFixed: boolean }[];
}

const key = (r: ItemRef) => `${r.kind}:${r.id}`;

/**
 * Phase 5 §6. Everything is production-skill evidence:
 *  - used_well and correctly-used prompt words -> journal_correct_use
 *  - an issue carrying an itemRef -> journal_misuse (context.selfFixed marks
 *    the milder case — see applyEvidence)
 * An item that was misused anywhere in the entry never also gets credit.
 */
export function planJournalEvidence(input: JournalEvidenceInput): Evidence[] {
  const context = (selfFixed?: boolean): Evidence['context'] => ({
    source: 'journal',
    refId: input.entryId,
    ...(selfFixed === undefined ? {} : { selfFixed }),
  });

  const events: Evidence[] = [];
  const misused = new Set<string>();
  for (const { issue, selfFixed } of input.issues) {
    if (!issue.itemRef || misused.has(key(issue.itemRef))) continue;
    misused.add(key(issue.itemRef));
    events.push({
      item: issue.itemRef,
      skill: 'production',
      kind: 'journal_misuse',
      at: input.now,
      context: context(selfFixed),
    });
  }

  const credited = new Set<string>();
  const credit = (item: ItemRef) => {
    if (misused.has(key(item)) || credited.has(key(item))) return;
    credited.add(key(item));
    events.push({
      item,
      skill: 'production',
      kind: 'journal_correct_use',
      at: input.now,
      context: context(),
    });
  };
  for (const u of input.usedWell) credit(u.itemRef);
  for (const id of input.promptWordsUsed) credit({ kind: 'word', id });
  return events;
}
