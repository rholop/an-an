import { computeCharStats, transparency, type SkillCard } from './learner/index.js';
import { newItemInBounds } from './learner/review-pile.js';
import type { Lexicon } from './lexicon.js';
import type { Level, Word } from './types.js';
import { LEVEL_IDS } from './levels.config.js';
import { tagsInScope, type ClassScope } from './textbook/scope.js';
import { PROGRESS_CONFIG } from './progress/progress.config.js';
import { levelItems, ProgressIndex } from './progress/terms.js';

const LEVEL_ORDER = LEVEL_IDS;

export interface CurriculumConfig {
  /** Share of the current level that must be in review+ before the next
   * level starts trickling in (CLAUDE.md default 70%). */
  levelAdvanceThreshold: number;
  /** Share of each nextNewItems() batch drawn from the next level once the
   * current level has crossed levelAdvanceThreshold (default 20%). */
  nextLevelTrickleShare: number;
}

export const DEFAULT_CURRICULUM_CONFIG: CurriculumConfig = {
  levelAdvanceThreshold: PROGRESS_CONFIG.levelUpLearnedShare,
  nextLevelTrickleShare: 0.2,
};

export interface CurriculumContext {
  /** Scenario/topic tags to prefer (e.g. the current chat scenario) — words
   * tagged with one of these sort first within their level. */
  scenarioTags?: string[];
  /** Phase 7: the learner's chosen level ("My level"). When set it IS the
   * frontier for new-item picks; the 70% rule below only *suggests* moving
   * up (see levelUpSuggestion) and never switches by itself. When unset the
   * frontier is derived from progress as before. */
  currentLevel?: Level;
  /** Phase 12 "My class": textbook words beyond the class (+ "lessons ahead") stay out of
   * the queue. Since Phase 21 this is visibility only; priority comes from `priorityIds`. */
  classScope?: ClassScope;
  /** Phase 21: word ids in study-focus order (active lesson, then catch-up lessons), from
   * `getStudyFocus`. Picked first; the TOCFL gate is already applied by the focus. */
  priorityIds?: readonly string[];
}

/** Phase 21: share of `level`'s TOCFL words the learner has Learned (the shared definition). */
export function levelCoverage(level: Level, words: Word[], cards: SkillCard[]): number {
  return new ProgressIndex({ cards }).summarize(levelItems(level, words)).learnedShare;
}

/** Lowest level that hasn't crossed `levelAdvanceThreshold` yet — the
 * learner's main frontier. Falls back to the last level once everything is
 * past threshold. Levels are a frontier, not a gate (phase doc §2): this
 * only decides the *main* pool for nextNewItems, which also trickles in the
 * next level once this one is far enough along. */
export function currentFrontierLevel(
  words: Word[],
  cards: SkillCard[],
  config: CurriculumConfig = DEFAULT_CURRICULUM_CONFIG,
): Level {
  for (const level of LEVEL_ORDER) {
    if (levelCoverage(level, words, cards) < config.levelAdvanceThreshold) return level;
  }
  return LEVEL_ORDER[LEVEL_ORDER.length - 1]!;
}

function touchedItemIds(cards: SkillCard[]): Set<string> {
  // Any card past the explicit 'unseen' state counts as "already queued or
  // beyond" — a placement_unknown row (state: 'unseen') stays eligible.
  return new Set(cards.filter((c) => c.state !== 'unseen').map((c) => c.item.id));
}

function sortCandidates(
  candidates: Word[],
  charStatsSource: SkillCard[],
  lexicon: Lexicon,
  context: CurriculumContext,
): Word[] {
  const charStats = computeCharStats(charStatsSource, lexicon);
  const scenarioTags = new Set(context.scenarioTags ?? []);
  return [...candidates].sort((a, b) => {
    const aTagMatch = a.tags.some((t) => scenarioTags.has(t)) ? 0 : 1;
    const bTagMatch = b.tags.some((t) => scenarioTags.has(t)) ? 0 : 1;
    if (aTagMatch !== bTagMatch) return aTagMatch - bTagMatch;

    const aFreq = a.freqRank ?? Number.POSITIVE_INFINITY;
    const bFreq = b.freqRank ?? Number.POSITIVE_INFINITY;
    if (aFreq !== bFreq) return aFreq - bFreq;

    return transparency(b, charStats) - transparency(a, charStats);
  });
}

/**
 * Picks the next `n` new (never-introduced) words to show the learner:
 * mostly from the current frontier level plus any supplement/custom words
 * (level: null — always in the queue, per phase doc §2), ordered by
 * (scenario tag match, freqRank, transparency); once the frontier level is
 * >= levelAdvanceThreshold "known", a trickle of the next level is mixed in.
 */
export function nextNewItems(
  cards: SkillCard[],
  lexicon: Lexicon,
  n: number,
  context: CurriculumContext = {},
  config: CurriculumConfig = DEFAULT_CURRICULUM_CONFIG,
): Word[] {
  if (n <= 0) return [];
  const words = lexicon.allWords();
  const touched = touchedItemIds(cards);
  const notIntroduced = (w: Word) => !touched.has(w.id);

  const frontier = context.currentLevel ?? currentFrontierLevel(words, cards, config);
  const frontierIdx = LEVEL_ORDER.indexOf(frontier);
  const nextLevel = LEVEL_ORDER[frontierIdx + 1];

  const scope = context.classScope?.enabled ? context.classScope : undefined;
  const inScope = (w: Word) => !scope || tagsInScope(w.tags, scope);

  // Phase 20: new picks stay in bounds — TOCFL, textbook and the learner's own words; never the
  // 17k level-less MOE compounds, names, or other supplementary entries.
  const mainPool = words.filter(
    (w) =>
      (w.level === frontier || w.source === 'custom') && newItemInBounds(w) && notIntroduced(w) && inScope(w),
  );
  const trickleEligible =
    levelCoverage(frontier, words, cards) >= config.levelAdvanceThreshold && nextLevel;
  const tricklePool = trickleEligible
    ? words.filter((w) => w.level === nextLevel && newItemInBounds(w) && notIntroduced(w) && inScope(w))
    : [];

  const trickleCount = trickleEligible ? Math.round(n * config.nextLevelTrickleShare) : 0;
  const mainCount = n - trickleCount;

  const sortedMain = sortCandidates(mainPool, cards, lexicon, context);
  const sortedTrickle = sortCandidates(tricklePool, cards, lexicon, context);

  // Phase 21: the study focus decides what comes first (active lesson, then catch-up lessons).
  const priority: Word[] = [];
  for (const id of context.priorityIds ?? []) {
    const w = lexicon.byId(id);
    if (w && notIntroduced(w) && inScope(w) && !priority.includes(w)) priority.push(w);
  }
  let picked: Word[] = priority.slice(0, n);
  if (picked.length >= n) return picked;
  const left = n - picked.length;
  const leftTrickle = Math.min(trickleCount, Math.round(left * config.nextLevelTrickleShare));
  for (const w of [...sortedMain.slice(0, left - leftTrickle), ...sortedTrickle.slice(0, leftTrickle), ...sortedMain.slice(left - leftTrickle)]) {
    if (picked.length >= n) break;
    if (!picked.includes(w)) picked.push(w);
  }
  if (priority.length > 0) return picked.slice(0, n);

  picked = [...sortedMain.slice(0, mainCount), ...sortedTrickle.slice(0, trickleCount)];
  // Backfill from the main pool if the trickle pool came up short.
  if (picked.length < n) {
    for (const w of sortedMain.slice(mainCount)) {
      if (picked.length >= n) break;
      if (!picked.includes(w)) picked.push(w);
    }
  }
  return picked.slice(0, n);
}

/**
 * Phase 7 §4: "Ready to try L3?". The next level, once `level` is covered at
 * least `levelAdvanceThreshold` (the same 70% rule that used to move the
 * frontier automatically). A suggestion only — callers show a prompt and the
 * learner decides. Null if not ready or already on the last level.
 */
export function levelUpSuggestion(
  level: Level,
  words: Word[],
  cards: SkillCard[],
  config: CurriculumConfig = DEFAULT_CURRICULUM_CONFIG,
): Level | null {
  const next = LEVEL_ORDER[LEVEL_ORDER.indexOf(level) + 1];
  if (!next) return null;
  return levelCoverage(level, words, cards) >= config.levelAdvanceThreshold ? next : null;
}
