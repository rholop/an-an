import { Rating, type FSRS } from 'ts-fsrs';
import { buildFsrs, computeItemState, emptyCard } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type LearnerConfig } from '../learner/types.js';
import type { ItemState } from '../types.js';
import { sentenceAround } from './sentences.js';
import type { ErrorItem, JournalIssue, Span } from './types.js';

export interface IssueForBank {
  issue: JournalIssue;
  /** Index into the review's issue list — keeps the ErrorItem id stable. */
  index: number;
}

/** Phase 5 §7: one ErrorItem per non-flagged issue. Sentences containing an
 * unresolved `[English gap]` are skipped — they'd make a confusing cloze. */
export function buildErrorItems(
  journalEntryId: string,
  text: string,
  issues: IssueForBank[],
  now: Date,
): ErrorItem[] {
  const items: ErrorItem[] = [];
  for (const { issue, index } of issues) {
    const [s, e] = sentenceAround(text, issue.span);
    const original = text.slice(s, e);
    if (/[[［\]］]/.test(original)) continue;
    const span: Span = [issue.span[0] - s, issue.span[1] - s];
    items.push({
      id: `${journalEntryId}:${index}`,
      journalEntryId,
      original,
      corrected: original.slice(0, span[0]) + issue.correction + original.slice(span[1]),
      span,
      type: issue.type,
      pattern: issue.pattern,
      itemRef: issue.itemRef,
      card: emptyCard(now),
      flagged: false,
      createdAt: now,
    });
  }
  return items;
}

/** Where the corrected text sits inside `corrected`: everything outside the
 * span is identical in both sentences, so only the end needs recomputing. */
export function errorBlankSpan(item: Pick<ErrorItem, 'original' | 'corrected' | 'span'>): Span {
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

const STRIP = /[\s，。、！？,.!?；;：:「」『』"'（）()]/g;
const normalise = (s: string) => s.normalize('NFKC').replace(STRIP, '');

export type ErrorOutcome = 'correct' | 'wrong';

export function gradeErrorAnswer(typed: string, item: ErrorItem): ErrorOutcome {
  return normalise(typed) === normalise(buildErrorCloze(item).answer) ? 'correct' : 'wrong';
}

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
    outcome === 'correct' ? Rating.Good : Rating.Again,
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
    if (it.flagged || !it.pattern) continue;
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
    .filter((i) => !i.flagged && i.card.due <= now)
    .sort((a, b) => weight(b) - weight(a) || a.card.due.getTime() - b.card.due.getTime())
    .slice(0, limit);
}
