import { checkTaiwanness } from '../taiwanness.js';
import type { Lexicon } from '../lexicon.js';
import { segment, type HintToken, type Token } from '../segment.js';
import type { Level } from '../types.js';
import type { TurnResponse } from '../chat/types.js';
import { LEVEL_IDS } from '../levels.config.js';

const LEVEL_ORDER = LEVEL_IDS;

export type TokenClass =
  'known' | 'due' | 'target' | 'learning' | 'allowed' | 'out_of_level' | 'unlisted';

export interface ClassifiedToken {
  token: Token;
  wordId?: string;
  class: TokenClass;
}

export interface ValidateConfig {
  /** Default 0.95, tunable 0.90–0.98 per CLAUDE.md. */
  coverageThreshold: number;
  /** "new/unknown tokens ≤ 4" — counts target + out_of_level + unlisted. */
  maxUnknownTokens: number;
}

export const DEFAULT_VALIDATE_CONFIG: ValidateConfig = {
  coverageThreshold: 0.95,
  maxUnknownTokens: 4,
};

export interface AnalyzeContext {
  lexicon: Lexicon;
  learnerLevel: Level;
  /** Item ids (Word.id) the learner knows at state >= review. */
  knownIds: ReadonlySet<string>;
  dueIds: ReadonlySet<string>;
  targetIds: ReadonlySet<string>;
  learningIds: ReadonlySet<string>;
  /** Scenario-specific extra vocab explicitly allowed this turn (word ids). */
  allowedExtraIds: ReadonlySet<string>;
}

export interface AnalyzeResult {
  pass: boolean;
  coverage: number;
  maxLevel: Level | null;
  unknown: ClassifiedToken[];
  classifications: ClassifiedToken[];
  taiwanness: ReturnType<typeof checkTaiwanness>;
}

const COMPREHENSIBLE: ReadonlySet<TokenClass> = new Set(['known', 'due', 'learning', 'allowed']);
const UNKNOWN_CLASSES: ReadonlySet<TokenClass> = new Set(['target', 'out_of_level', 'unlisted']);

function classifyWordToken(token: Token, ctx: AnalyzeContext): ClassifiedToken {
  const candidates = ctx.lexicon.lookup(token.text);
  if (candidates.length === 0) return { token, class: 'unlisted' };

  const prioritized =
    candidates.find((w) => ctx.knownIds.has(w.id)) ??
    candidates.find((w) => ctx.dueIds.has(w.id)) ??
    candidates.find((w) => ctx.targetIds.has(w.id)) ??
    candidates.find((w) => ctx.learningIds.has(w.id)) ??
    candidates.find((w) => ctx.allowedExtraIds.has(w.id)) ??
    candidates[0]!;
  const wordId = prioritized.id;

  // Names, NPC names, particles and fillers are always conversationally
  // fine regardless of the learner's level/progress (CLAUDE.md §4 "allowed").
  if (
    prioritized.tags.some((t) => t === 'name' || t === 'npc' || t === 'particle' || t === 'filler')
  ) {
    return { token, wordId, class: 'allowed' };
  }
  if (ctx.knownIds.has(wordId)) return { token, wordId, class: 'known' };
  if (ctx.dueIds.has(wordId)) return { token, wordId, class: 'due' };
  if (ctx.targetIds.has(wordId)) return { token, wordId, class: 'target' };
  if (ctx.learningIds.has(wordId)) return { token, wordId, class: 'learning' };
  if (ctx.allowedExtraIds.has(wordId)) return { token, wordId, class: 'allowed' };

  if (
    prioritized.level !== null &&
    LEVEL_ORDER.indexOf(prioritized.level) > LEVEL_ORDER.indexOf(ctx.learnerLevel)
  ) {
    return { token, wordId, class: 'out_of_level' };
  }
  // A real lexicon word, at/below the learner's level, but not part of
  // their tracked known/due/target/learning state — still a gap, counts
  // against coverage rather than being silently waved through.
  return { token, wordId, class: 'unlisted' };
}

/** Locates each hinted token's text as a substring of `text`, in order,
 * producing segmenter-compatible HintTokens. Hints that can't be found (the
 * LLM's own tokenization drifted from its reply_zh) are silently skipped —
 * hints are advisory only; segment() re-derives the real boundaries. */
export function locateHints(text: string, hintTexts: string[]): HintToken[] {
  const hints: HintToken[] = [];
  let cursor = 0;
  for (const t of hintTexts) {
    if (!t) continue;
    const idx = text.indexOf(t, cursor);
    if (idx === -1) continue;
    hints.push({ start: idx, end: idx + t.length });
    cursor = idx + t.length;
  }
  return hints;
}

/**
 * The validator's core, reusable beyond chat turns (journal feedback,
 * sentence-bank QA — CLAUDE.md §4 "Also exposed as analyzeText(text)").
 */
export function analyzeText(
  text: string,
  ctx: AnalyzeContext,
  hints: HintToken[] = [],
  config: ValidateConfig = DEFAULT_VALIDATE_CONFIG,
): AnalyzeResult {
  const tokens = segment(text, ctx.lexicon, { hints });
  const classifications: ClassifiedToken[] = [];

  for (const token of tokens) {
    if (token.kind === 'word') {
      classifications.push(classifyWordToken(token, ctx));
    } else if (token.kind === 'unknown') {
      // OOV Chinese span the segmenter couldn't match at all — effectively
      // made-up/unrecognized text, counts against coverage.
      classifications.push({ token, class: 'unlisted' });
    }
    // number/latin/punct tokens aren't vocabulary content; excluded entirely.
  }

  const total = classifications.length;
  const comprehensibleCount = classifications.filter((c) => COMPREHENSIBLE.has(c.class)).length;
  const coverage = total === 0 ? 1 : comprehensibleCount / total;
  const unknown = classifications.filter((c) => UNKNOWN_CLASSES.has(c.class));

  let maxLevel: Level | null = null;
  for (const c of classifications) {
    if (!c.wordId) continue;
    const word = ctx.lexicon.byId(c.wordId);
    if (!word?.level) continue;
    if (!maxLevel || LEVEL_ORDER.indexOf(word.level) > LEVEL_ORDER.indexOf(maxLevel))
      maxLevel = word.level;
  }

  const taiwanness = checkTaiwanness(text);
  const pass =
    coverage >= config.coverageThreshold &&
    unknown.length <= config.maxUnknownTokens &&
    taiwanness.isClean;

  return { pass, coverage, maxLevel, unknown, classifications, taiwanness };
}

/** Validates a full LLM TurnResponse's reply_zh, using its own `tokens` as
 * segmentation hints. */
export function validateTurnResponse(
  response: Pick<TurnResponse, 'reply_zh' | 'tokens'>,
  ctx: AnalyzeContext,
  config: ValidateConfig = DEFAULT_VALIDATE_CONFIG,
): AnalyzeResult {
  const hints = locateHints(
    response.reply_zh,
    response.tokens.map((t) => t.text),
  );
  return analyzeText(response.reply_zh, ctx, hints, config);
}
