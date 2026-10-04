import { z } from 'zod';
import { LEVEL_IDS } from '../levels.config.js';
import { LevelSchema } from './level-schema.js';
import type { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import { courseOrdinal, LAIXUE_COURSE } from '../textbook/course.js';

export const ScenarioGoalStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** Fallback completion signal: if the LLM's own goal_progress doesn't
   * mark this step done, the UI can heuristically check whether any of
   * these appeared in the learner's recent turns. Not authoritative —
   * goal_progress from the model is. */
  keywordHints: z.array(z.string()).default([]),
});

export const ScenarioNpcSchema = z.object({
  id: z.string(),
  name: z.string(),
  personality: z.string(),
  speechStyle: z.string(),
  particles: z.array(z.string()).default([]),
});

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  levelRange: z.object({ min: LevelSchema, max: LevelSchema }),
  npc: ScenarioNpcSchema,
  setting: z.string(),
  goalSteps: z.array(ScenarioGoalStepSchema).min(1),
  /** Headwords (not yet resolved to lexicon ids — see resolveScenarioVocabExtraIds). */
  vocabExtras: z.array(z.string()).default([]),
  opener: z.object({ zh: z.string(), en: z.string() }),
  successLine: z.object({ zh: z.string(), en: z.string() }),
  /** Phase 12: built for a textbook lesson. Hidden unless "My class" is on;
   * unlocks when the class's current lesson >= `lesson`. */
  textbook: z.object({ textbookId: z.string(), lesson: z.number().int().min(1) }).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioFileSchema = z.object({
  meta: z.object({ version: z.string(), buildDate: z.string() }),
  scenarios: z.array(ScenarioSchema),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

const LEVEL_ORDER = LEVEL_IDS;

/** Scenario unlock by level lives in data (CLAUDE.md §5): a scenario is
 * available once the learner's level falls within [min, max]. */
export function isScenarioUnlocked(scenario: Scenario, learnerLevel: Level): boolean {
  // Textbook scenarios are governed by the class setting, not the level
  // picker — see isTextbookScenarioUnlocked.
  if (scenario.textbook) return false;
  const idx = LEVEL_ORDER.indexOf(learnerLevel);
  return (
    idx >= LEVEL_ORDER.indexOf(scenario.levelRange.min) &&
    idx <= LEVEL_ORDER.indexOf(scenario.levelRange.max)
  );
}

/** Phase 7 level filter: does the scenario's [min, max] range include any of
 * the selected levels? An empty selection means "no filter". */
export function scenarioMatchesLevels(scenario: Scenario, levels: readonly Level[]): boolean {
  if (levels.length === 0) return true;
  const lo = LEVEL_ORDER.indexOf(scenario.levelRange.min);
  const hi = LEVEL_ORDER.indexOf(scenario.levelRange.max);
  return levels.some((l) => LEVEL_ORDER.indexOf(l) >= lo && LEVEL_ORDER.indexOf(l) <= hi);
}

/** Resolves a scenario's vocabExtras (headwords) to lexicon Word ids, for
 * TurnRequest.vocab.allowedExtras and the validator's allowedExtraIds.
 * Headwords with no lexicon match are skipped (not thrown), and logged via
 * the returned `missing` list so a human can fix the scenario YAML. */
export function resolveScenarioVocabExtraIds(
  scenario: Scenario,
  lexicon: Lexicon,
): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const headword of scenario.vocabExtras) {
    const matches = lexicon.lookup(headword);
    if (matches.length > 0) ids.push(matches[0]!.id);
    else missing.push(headword);
  }
  return { ids, missing };
}

/** Phase 12: a textbook scenario is available only while "My class" is on and
 * the class has reached its lesson. Non-textbook scenarios: not handled here. */
export function isTextbookScenarioUnlocked(
  scenario: Scenario,
  myClass: { enabled: boolean; textbookId: string; currentLesson: number } | undefined,
): boolean {
  if (!scenario.textbook || !myClass?.enabled) return false;
  // Course order: a lesson of an earlier book counts as covered too.
  const at = courseOrdinal(LAIXUE_COURSE, myClass.textbookId, myClass.currentLesson);
  const of = courseOrdinal(LAIXUE_COURSE, scenario.textbook.textbookId, scenario.textbook.lesson);
  if (at === undefined || of === undefined) {
    return (
      scenario.textbook.textbookId === myClass.textbookId &&
      myClass.currentLesson >= scenario.textbook.lesson
    );
  }
  return at >= of;
}
