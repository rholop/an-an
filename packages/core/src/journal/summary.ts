import { isShowableErrorItem } from '../cloze/report.js';
import type { Lexicon } from '../lexicon.js';
import type { Level } from '../types.js';
import { analyzeText } from '../validate/turn.js';
import type { ErrorItem } from './types.js';
import { normalisePattern } from './error-bank.js';
import { replaceGaps } from './bracket.js';
import { LAST_LEVEL, LEVEL_IDS, levelLabel } from '../levels.config.js';

const LEVEL_ORDER = LEVEL_IDS;

export interface LevelSummary {
  byLevel: Partial<Record<Level, number>>;
  dominant: Level | null;
  /** Distinct headwords used, in order of first appearance. */
  wordsUsed: string[];
  /** e.g. "Mostly Level 2 words, 3 Level 3 words". */
  headline: string;
}

/** Phase 5 §8's "mostly Level 2 words, 3 L3 words", built on analyzeText's
 * token classification (the same segmentation the chat validator uses).
 * `[English gaps]` are removed first — they aren't the learner's Chinese. */
export function summarizeLevels(
  text: string,
  lexicon: Lexicon,
  currentLevel?: Level,
): LevelSummary {
  const plain = replaceGaps(text, () => ' ');
  const none = new Set<string>();
  const result = analyzeText(plain, {
    lexicon,
    learnerLevel: LAST_LEVEL,
    knownIds: none,
    dueIds: none,
    targetIds: none,
    learningIds: none,
    allowedExtraIds: none,
  });

  const byLevel: Partial<Record<Level, number>> = {};
  const wordsUsed: string[] = [];
  for (const c of result.classifications) {
    if (!c.wordId) continue;
    const word = lexicon.byId(c.wordId);
    if (!word) continue;
    if (!wordsUsed.includes(c.token.text)) wordsUsed.push(c.token.text);
    if (word.level) byLevel[word.level] = (byLevel[word.level] ?? 0) + 1;
  }

  let dominant: Level | null = null;
  for (const level of LEVEL_ORDER) {
    if (byLevel[level] && (dominant === null || byLevel[level]! > byLevel[dominant]!))
      dominant = level;
  }

  let headline = 'Not enough words to analyse yet';
  if (dominant) {
    const above = LEVEL_ORDER.filter(
      (l) => LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(dominant!) && byLevel[l],
    );
    headline = [
      `Mostly ${levelLabel(dominant)} words`,
      ...above.map((l) => `${byLevel[l]} ${levelLabel(l)} word${byLevel[l] === 1 ? '' : 's'}`),
    ].join(', ');
  }
  // Phase 7: relative to the learner's chosen level.
  if (dominant && currentLevel) {
    const above = LEVEL_ORDER.filter(
      (l) => LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(currentLevel),
    ).reduce((n, l) => n + (byLevel[l] ?? 0), 0);
    headline +=
      above === 0
        ? ` — all within your level (${currentLevel})`
        : ` — ${above} above your level (${currentLevel})`;
  }
  return { byLevel, dominant, wordsUsed, headline };
}

/** Characters the learner actually wrote in Chinese: everything except
 * whitespace and `[English gaps]`. */
export function countWrittenChars(text: string): number {
  return [...replaceGaps(text, () => '').replace(/\s/g, '')].length;
}

/** Phase 5 §8 metric (CLAUDE.md "journal errors per 100 characters over
 * time"). Null when nothing was written. */
export function errorsPer100Chars(issueCount: number, text: string): number | null {
  const chars = countWrittenChars(text);
  return chars === 0 ? null : (issueCount / chars) * 100;
}

export interface PatternRecurrence {
  pattern: string;
  /** Number of distinct journal entries the pattern appeared in. */
  entries: number;
}

/** Patterns that showed up in more than one entry, most recurrent first. */
export function patternRecurrence(items: readonly ErrorItem[]): PatternRecurrence[] {
  const entriesByPattern = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.pattern || !isShowableErrorItem(it)) continue;
    const key = normalisePattern(it.pattern);
    const set = entriesByPattern.get(key) ?? new Set<string>();
    set.add(it.journalEntryId);
    entriesByPattern.set(key, set);
  }
  return [...entriesByPattern.entries()]
    .map(([pattern, set]) => ({ pattern, entries: set.size }))
    .filter((p) => p.entries > 1)
    .sort((a, b) => b.entries - a.entries || a.pattern.localeCompare(b.pattern));
}
