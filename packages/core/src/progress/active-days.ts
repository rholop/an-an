// Phase 32 Part A: the days the learner did something meaningful (the streak's only input).
// One row per profile-zone day is written the first time each day the learner answers anything,
// finishes a journal entry or a story, completes a chat scenario or sends an open-chat turn. Passive
// reads, lookups, imports and placement never count. The same rule back-fills the past once.

import { dayKey } from './time.js';

/** Evidence kinds that are an answer by the learner (review, cloze, lesson steps, listening,
 * pinyin, grammar, journal uses, "I already know this"). */
export const ACTIVITY_EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  'review_again',
  'review_hard',
  'review_good',
  'review_easy',
  'cloze_correct_nohint',
  'cloze_correct_hint',
  'cloze_wrong',
  'journal_correct_use',
  'journal_misuse',
  'listening_correct',
  'listening_correct_replayed',
  'listening_wrong',
  'reading_correct',
  'reading_tone_wrong',
  'reading_wrong',
  'known_check_passed',
]);

/** Does this evidence row make its day active? */
export function countsAsActivity(e: { kind: string }): boolean {
  return ACTIVITY_EVIDENCE_KINDS.has(e.kind);
}

/** One stored active day: the day key (profile zone) and the first moment it was seen. */
export interface ActiveDay {
  day: string;
  at: Date;
}

/** What the one-time back-fill reads from a profile's history. */
export interface ActivityHistory {
  evidence?: readonly { kind: string; at: Date }[];
  /** Reward events; a revoking event (Undo) is not an activity. */
  rewards?: readonly { at: Date; revokes?: string }[];
  journalEntries?: readonly { status: string; finishedAt?: Date }[];
  stories?: readonly { readAt?: Date; readDates?: readonly Date[] }[];
  conversations?: readonly { id?: number; kind?: string; completed?: boolean; endedAt?: Date }[];
  turns?: readonly { conversationId: number; role: string; at: Date }[];
}

/** Every active day in a history, earliest moment first (the back-fill's rows). */
export function activeDaysFromHistory(history: ActivityHistory, timeZone: string): ActiveDay[] {
  const first = new Map<string, Date>();
  const add = (at: Date | undefined) => {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) return;
    const day = dayKey(at, timeZone);
    const have = first.get(day);
    if (!have || at < have) first.set(day, at);
  };
  for (const e of history.evidence ?? []) if (countsAsActivity(e)) add(e.at);
  for (const r of history.rewards ?? []) if (!r.revokes) add(r.at);
  for (const j of history.journalEntries ?? []) if (j.status === 'finished') add(j.finishedAt);
  for (const s of history.stories ?? []) for (const at of s.readDates ?? (s.readAt ? [s.readAt] : [])) add(at);
  const open = new Set<number>();
  for (const c of history.conversations ?? []) {
    if (c.completed) add(c.endedAt);
    if (c.kind === 'open' && c.id !== undefined) open.add(c.id);
  }
  for (const t of history.turns ?? []) if (t.role === 'learner' && open.has(t.conversationId)) add(t.at);
  return [...first.entries()].map(([day, at]) => ({ day, at })).sort((a, b) => a.day.localeCompare(b.day));
}

/** Sync: active days are append-only, unioned by day; the earlier moment wins (so every device
 * ends with the same row whichever back-filled first). */
export function mergeActiveDays(a: readonly ActiveDay[], b: readonly ActiveDay[]): ActiveDay[] {
  const out = new Map<string, ActiveDay>();
  for (const row of [...a, ...b]) {
    const have = out.get(row.day);
    if (!have || row.at.getTime() < have.at.getTime()) out.set(row.day, row);
  }
  return [...out.values()].sort((x, y) => x.day.localeCompare(y.day));
}
