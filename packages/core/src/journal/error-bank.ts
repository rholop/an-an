import { Rating, type FSRS } from 'ts-fsrs';
import { buildFsrs, computeItemState } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type LearnerConfig } from '../learner/types.js';
import type { ItemState } from '../types.js';
import {
  checkJournalCloze,
  type ClozeCheckLLM,
  type ClozeCheckOptions,
} from '../cloze/check-journal-cloze.js';
import { blockErrorItem, isShowableErrorItem } from '../cloze/report.js';
import type { ErrorItem, Span } from './types.js';

/** Where the blank sits in `corrected`. Items built with other corrections in
 * the same sentence carry it explicitly; older ones derive it from the span
 * (everything outside the span was identical). */
export function errorBlankSpan(
  item: Pick<ErrorItem, 'original' | 'corrected' | 'span'> & { blank?: Span },
): Span {
  if (item.blank) return item.blank;
  return [item.span[0], item.corrected.length - (item.original.length - item.span[1])];
}

export interface ErrorCloze {
  sentence: string;
  blankStart: number;
  blankEnd: number;
  answer: string;
}

export function buildErrorCloze(item: ErrorItem): ErrorCloze {
  const [blankStart, blankEnd] = errorBlankSpan(item);
  return {
    sentence: item.corrected,
    blankStart,
    blankEnd,
    answer: item.corrected.slice(blankStart, blankEnd),
  };
}

/** Phase 16 Part B for one stored item: rules, then the cached naturalness
 * check. Returns the item with its new status; an unreachable model leaves it
 * `pending_check` (hidden) to be retried later. Already blocked/reported/
 * deleted items are returned untouched. */
export async function checkErrorItem(
  item: ErrorItem,
  opts: ClozeCheckOptions & { llm?: ClozeCheckLLM },
): Promise<ErrorItem> {
  if (item.status && item.status !== 'pending_check' && item.status !== 'active') return item;
  const cloze = buildErrorCloze(item);
  const verdict = await checkJournalCloze(
    {
      sentence: cloze.sentence,
      blankStart: cloze.blankStart,
      blankEnd: cloze.blankEnd,
      answer: cloze.answer,
    },
    opts,
  );
  if (verdict.status === 'ok') {
    const { blockedReason: _r, ...rest } = item;
    return { ...rest, status: 'active' };
  }
  if (verdict.status === 'blocked') return blockErrorItem(item, verdict.reason);
  return { ...item, status: 'pending_check' };
}

/** 'hint' = right word, wrong tone: a Hard, not a lapse. */
export type ErrorOutcome = 'correct' | 'hint' | 'wrong';

/** Applies one cloze answer to the item's own FSRS card (no SkillCard — an
 * error item is a sentence, not a word/sense). */
export function reviewErrorItem(
  item: ErrorItem,
  outcome: ErrorOutcome,
  now: Date,
  config: LearnerConfig = DEFAULT_LEARNER_CONFIG,
  fsrsInstance: FSRS = buildFsrs(config),
): ErrorItem {
  const { card } = fsrsInstance.next(
    item.card,
    now,
    outcome === 'correct' ? Rating.Good : outcome === 'hint' ? Rating.Hard : Rating.Again,
  );
  return { ...item, card };
}

export function errorItemState(
  item: ErrorItem,
  config: LearnerConfig = DEFAULT_LEARNER_CONFIG,
): ItemState {
  return computeItemState(item.card, config);
}

export const normalisePattern = (p: string) => p.trim().toLowerCase();

/** Occurrences of each pattern across all unflagged error items. */
export function patternCounts(items: readonly ErrorItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it.pattern || !isShowableErrorItem(it)) continue;
    const key = normalisePattern(it.pattern);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Most frequent recent patterns, for the review request ("pass the learner's
 * top recent error patterns") and the entry summary's "patterns to watch".
 * Only items created at/after `since` count when given. */
export function topErrorPatterns(items: readonly ErrorItem[], limit = 5, since?: Date): string[] {
  const recent = since ? items.filter((i) => i.createdAt >= since) : items;
  return [...patternCounts(recent).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([p]) => p);
}

export const RECURRING_PATTERN_MIN = 2;

/** Due, unflagged error items; recurring-pattern ones first (most frequent
 * pattern leading), then oldest-due. */
export function selectDueErrorItems(
  items: readonly ErrorItem[],
  now: Date,
  limit: number,
): ErrorItem[] {
  const counts = patternCounts(items);
  const weight = (i: ErrorItem) => {
    const c = i.pattern ? (counts.get(normalisePattern(i.pattern)) ?? 0) : 0;
    return c >= RECURRING_PATTERN_MIN ? c : 0;
  };
  return items
    .filter((i) => isShowableErrorItem(i) && i.card.due <= now)
    .sort((a, b) => weight(b) - weight(a) || a.card.due.getTime() - b.card.due.getTime())
    .slice(0, limit);
}
