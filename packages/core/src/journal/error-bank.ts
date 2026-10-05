import { Rating, type FSRS } from 'ts-fsrs';
import { buildFsrs, computeItemState, emptyCard } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type LearnerConfig } from '../learner/types.js';
import type { ItemState } from '../types.js';
import {
  checkJournalCloze,
  checkJournalClozeRules,
  type ClozeCheckLLM,
  type ClozeCheckOptions,
} from '../cloze/check-journal-cloze.js';
import { blockErrorItem, isShowableErrorItem } from '../cloze/report.js';
import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import { sentenceAround } from './sentences.js';
import type { ErrorItem, JournalIssue, Span } from './types.js';

export interface IssueForBank {
  issue: JournalIssue;
  /** Index into the review's issue list — keeps the ErrorItem id stable. */
  index: number;
}

export interface BuildErrorItemsOptions {
  /** With a lexicon the blank is widened to whole tokens (a span that splits a
   * word never makes a half-word blank). */
  lexicon?: Lexicon;
  /** Latin names the learner may use in a sentence. */
  allowedNames?: readonly string[];
}

const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

/** Widens `blank` to the edges of the tokens it touches. */
function alignToTokens(sentence: string, blank: Span, lexicon: Lexicon): Span {
  let [start, end] = blank;
  for (const t of segment(sentence, lexicon)) {
    if (t.start < blank[1] && blank[0] < t.end) {
      start = Math.min(start, t.start);
      end = Math.max(end, t.end);
    }
  }
  return [start, end];
}

/**
 * Phase 5 §7 + Phase 16 Part A: one ErrorItem per non-flagged issue.
 *
 * Every issue in a sentence is applied to the sentence at once, from the last
 * span to the first, so a sentence with 2-3 corrections is never shown with
 * the others still wrong, and no span points at shifted text. Each item's
 * blank is the item's own corrected text, moved by the length changes of
 * the earlier corrections and widened to whole tokens.
 *
 * Items come back `pending_check` (waiting for the naturalness check) or
 * `blocked` with the reason: a sentence with an English gap, an emoji or rare
 * character, or any other rule failure is kept as a blocked item rather than
 * silently dropped.
 */
export function buildErrorItems(
  journalEntryId: string,
  text: string,
  issues: IssueForBank[],
  now: Date,
  opts: BuildErrorItemsOptions = {},
): ErrorItem[] {
  // sentence range per issue; ranges that touch merge into one group
  const placed = issues
    .map((it) => ({ ...it, range: sentenceAround(text, it.issue.span) }))
    .sort((a, b) => a.range[0] - b.range[0]);
  const groups: { range: Span; members: typeof placed }[] = [];
  for (const p of placed) {
    const last = groups[groups.length - 1];
    if (last && p.range[0] < last.range[1]) {
      last.range = [last.range[0], Math.max(last.range[1], p.range[1])];
      last.members.push(p);
    } else groups.push({ range: [...p.range], members: [p] });
  }

  const items: ErrorItem[] = [];
  for (const g of groups) {
    const [s, e] = g.range;
    const original = text.slice(s, e);
    // non-overlapping, in text order
    const members = [...g.members].sort((a, b) => a.issue.span[0] - b.issue.span[0]);
    const usable = members.filter(
      (m, i) => i === 0 || m.issue.span[0] >= members[i - 1]!.issue.span[1],
    );
    // build the corrected sentence once, last span first, so offsets never drift
    let corrected = original;
    for (const m of [...usable].reverse()) {
      const a = m.issue.span[0] - s;
      const b = m.issue.span[1] - s;
      corrected = corrected.slice(0, a) + m.issue.correction + corrected.slice(b);
    }
    let shift = 0;
    for (const m of usable) {
      const span: Span = [m.issue.span[0] - s, m.issue.span[1] - s];
      const start = span[0] + shift;
      shift += m.issue.correction.length - (span[1] - span[0]);
      let blank: Span = [start, start + m.issue.correction.length];
      if (opts.lexicon) blank = alignToTokens(corrected, blank, opts.lexicon);

      // an emoji / non-BMP character earlier in the entry makes the model's
      // offsets (counted in characters) unreliable for this span
      const offsetsUnreliable = NON_BMP.test(text.slice(0, m.issue.span[1]));
      const item: ErrorItem = {
        id: `${journalEntryId}:${m.index}`,
        journalEntryId,
        original,
        corrected,
        span,
        blank,
        type: m.issue.type,
        pattern: m.issue.pattern,
        itemRef: m.issue.itemRef,
        card: emptyCard(now),
        flagged: false,
        createdAt: now,
        status: 'pending_check',
      };
      const rules = offsetsUnreliable
        ? ['offsets are unreliable (emoji or rare character earlier in the entry)']
        : opts.lexicon
          ? checkJournalClozeRules(
              {
                sentence: corrected,
                blankStart: blank[0],
                blankEnd: blank[1],
                answer: corrected.slice(blank[0], blank[1]),
              },
              { lexicon: opts.lexicon, allowedNames: opts.allowedNames },
            )
          : /[[［\]］]/.test(corrected)
            ? ['contains brackets or leftover markup']
            : [];
      items.push(rules.length > 0 ? blockErrorItem(item, rules.join('; ')) : item);
    }
  }
  return items;
}

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
    if (it.flagged || !it.pattern || it.status === 'blocked' || it.status === 'reported' || it.status === 'deleted') continue;
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
