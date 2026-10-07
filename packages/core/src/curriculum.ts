import { computeCharStats, transparency, type SkillCard } from './learner/index.js';
import { newItemInBounds } from './learner/review-pile.js';
import type { Lexicon } from './lexicon.js';
import type { Level, Word } from './types.js';
import { LEVEL_IDS } from './levels.config.js';
import { homeLessonOfTags, tagsInScope, type ClassScope } from './textbook/scope.js';

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
  levelAdvanceThreshold: 0.7,
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
  /** Phase 12 "My class". When enabled: the current lesson's words get top
   * priority, the next lesson's trickle in at `nextLevelTrickleShare`, and
   * textbook words from later lessons stay out of the queue. Disabled or
   * absent = exactly the previous behaviour. */
  classScope?: ClassScope;
}

/** Share of `level`'s words that are at least "in review" (recognition
 * skill) — i.e. genuinely being retained, not just introduced. */
export function levelCoverage(level: Level, words: Word[], cards: SkillCard[]): number {
  const atLevel = words.filter((w) => w.level === level);
  if (atLevel.length === 0) return 1;
  const strongIds = new Set(
    cards
      .filter((c) => c.skill === 'recognition' && (c.state === 'review' || c.state === 'mature'))
      .map((c) => c.item.id),
  );
  const strongCount = atLevel.filter((w) => strongIds.has(w.id)).length;
  return strongCount / atLevel.length;
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

/** Current lesson first, then the most recent earlier lessons. */
function lessonRank(lesson: number, scope: ClassScope): number {
  return scope.currentLesson - lesson;
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
  const lessonOf = (w: Word) => (scope ? homeLessonOfTags(w.tags, scope.course)?.ordinal : undefined);

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

  let picked: Word[];
  if (scope) {
    // Textbook words regardless of level: the class is the frontier.
    const tbPool = words.filter(
      (w) => notIntroduced(w) && lessonOf(w) !== undefined && inScope(w) && newItemInBounds(w),
    );
    const covered = sortCandidates(
      tbPool.filter((w) => lessonOf(w)! <= scope.currentLesson),
      cards,
      lexicon,
      context,
    ).sort((a, b) => lessonRank(lessonOf(a)!, scope) - lessonRank(lessonOf(b)!, scope));
    const nextLesson = sortCandidates(
      tbPool.filter((w) => lessonOf(w)! === scope.currentLesson + 1),
      cards,
      lexicon,
      context,
    );
    const nextCount = Math.min(nextLesson.length, Math.round(n * config.nextLevelTrickleShare));
    const head = covered.slice(0, n - nextCount);
    picked = [...head, ...nextLesson.slice(0, nextCount)];
    const rest = [...sortedMain, ...sortedTrickle, ...covered.slice(head.length), ...nextLesson.slice(nextCount)];
    for (const w of rest) {
      if (picked.length >= n) break;
      if (!picked.includes(w)) picked.push(w);
    }
    return picked.slice(0, n);
  }

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
