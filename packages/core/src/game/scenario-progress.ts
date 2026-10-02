import type { Scenario } from '../chat/scenario.js';
import type { Lexicon } from '../lexicon.js';
import type { Level } from '../types.js';
import { analyzeText, type AnalyzeContext } from '../validate/turn.js';
import { LEVEL_IDS } from '../levels.config.js';

const LEVEL_ORDER = LEVEL_IDS;

/** The slice of a stored conversation the game cares about. */
export interface ConversationRecord {
  scenarioId: string;
  startedAt: Date;
  endedAt?: Date;
  /** Every goal step was done (not merely "ended early"). */
  completed: boolean;
  /** Times "I'm stuck" was pressed. */
  stuckCount: number;
  /** English fallback was on for any learner turn. */
  englishFallbackUsed: boolean;
}

export interface Stars {
  /** 1: completed. 2: …without "I'm stuck". 3: …and with no English fallback. */
  completed: boolean;
  noStuck: boolean;
  noEnglish: boolean;
  count: 0 | 1 | 2 | 3;
}

export const NO_STARS: Stars = { completed: false, noStuck: false, noEnglish: false, count: 0 };

/** Phase 6 §3 star rating for ONE conversation. The three stars are
 * independent achievements: "no stuck" and "no English" only count when the
 * scenario was actually completed. */
export function starsFor(c: ConversationRecord): Stars {
  const noStuck = c.completed && c.stuckCount === 0;
  const noEnglish = c.completed && !c.englishFallbackUsed;
  return {
    completed: c.completed,
    noStuck,
    noEnglish,
    count: ((c.completed ? 1 : 0) + (noStuck ? 1 : 0) + (noEnglish ? 1 : 0)) as Stars['count'],
  };
}

/** Best stars per criterion across all attempts. */
export function bestStars(conversations: readonly ConversationRecord[]): Stars {
  return conversations.map(starsFor).reduce<Stars>((best, s) => {
    const completed = best.completed || s.completed;
    const noStuck = best.noStuck || s.noStuck;
    const noEnglish = best.noEnglish || s.noEnglish;
    return {
      completed,
      noStuck,
      noEnglish,
      count: ((completed ? 1 : 0) + (noStuck ? 1 : 0) + (noEnglish ? 1 : 0)) as Stars['count'],
    };
  }, NO_STARS);
}

/** Phase 6 §3: scenarios unlock from the Phase 2 frontier — once the learner's
 * frontier reaches a scenario's minimum level it stays available (so earlier
 * scenarios can be replayed for stars), unlike chat's older min..max window. */
export function isScenarioAvailable(scenario: Scenario, frontier: Level): boolean {
  return LEVEL_ORDER.indexOf(frontier) >= LEVEL_ORDER.indexOf(scenario.levelRange.min);
}

export interface ScenarioNode {
  scenario: Scenario;
  unlocked: boolean;
  stars: Stars;
  attempts: number;
  /** Fastest unassisted (no stuck, no English) completion, in ms. */
  bestUnassistedMs?: number;
}

/** The scenario map: sorted by level, then title. */
export function buildScenarioMap(
  scenarios: readonly Scenario[],
  frontier: Level,
  conversations: readonly ConversationRecord[],
): ScenarioNode[] {
  return [...scenarios]
    .sort(
      (a, b) =>
        LEVEL_ORDER.indexOf(a.levelRange.min) - LEVEL_ORDER.indexOf(b.levelRange.min) ||
        a.title.localeCompare(b.title),
    )
    .map((scenario) => {
      const mine = conversations.filter((c) => c.scenarioId === scenario.id);
      const unassisted = mine
        .filter((c) => c.completed && c.stuckCount === 0 && !c.englishFallbackUsed && c.endedAt)
        .map((c) => c.endedAt!.getTime() - c.startedAt.getTime());
      return {
        scenario,
        unlocked: isScenarioAvailable(scenario, frontier),
        stars: bestStars(mine),
        attempts: mine.length,
        bestUnassistedMs: unassisted.length > 0 ? Math.min(...unassisted) : undefined,
      };
    });
}

/** The Chinese lines that make up a scenario's "corpus": what the NPC opens
 * and closes with, the authored vocabulary, the keyword hints, plus any extra
 * lines (e.g. the NPC lines from the learner's own past chats of it). */
export function scenarioCorpus(scenario: Scenario, extraLines: readonly string[] = []): string[] {
  return [
    scenario.opener.zh,
    scenario.successLine.zh,
    ...scenario.vocabExtras,
    ...scenario.goalSteps.flatMap((g) => g.keywordHints),
    ...extraLines,
  ].filter((l) => l.trim().length > 0);
}

export interface ScenarioCoverage {
  /** Share of the corpus's word tokens the learner can comprehend, 0..1. */
  coverage: number;
  tokens: number;
  /** Distinct words the learner doesn't know yet, most frequent first. */
  missing: string[];
}

const COMPREHENSIBLE = new Set(['known', 'due', 'learning', 'allowed']);

/**
 * Phase 6 §4: "you can handle ~X% of the words in this scenario". Defined as
 * analyzeText's own coverage over the corpus (lines joined by newlines, which
 * the segmenter treats as punctuation), so it can never drift from the
 * validator the chat and cloze use — the test asserts exactly that.
 */
export function scenarioCoverage(corpus: readonly string[], ctx: AnalyzeContext): ScenarioCoverage {
  const result = analyzeText(corpus.join('\n'), ctx);
  const total = result.classifications.length;
  const counts = new Map<string, number>();
  for (const c of result.classifications) {
    if (!COMPREHENSIBLE.has(c.class)) counts.set(c.token.text, (counts.get(c.token.text) ?? 0) + 1);
  }
  return {
    coverage: result.coverage,
    tokens: total,
    missing: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([w]) => w),
  };
}

export function coverageContext(
  lexicon: Lexicon,
  learnerLevel: Level,
  knownIds: ReadonlySet<string>,
  learningIds: ReadonlySet<string> = new Set(),
): AnalyzeContext {
  const none = new Set<string>();
  return {
    lexicon,
    learnerLevel,
    knownIds,
    dueIds: none,
    targetIds: none,
    learningIds,
    allowedExtraIds: none,
  };
}
