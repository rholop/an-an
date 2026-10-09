import { PROGRESS_CONFIG } from '../progress/progress.config.js';
import { lessonCoreItems, type LearnedMastered, type ProgressIndex } from '../progress/terms.js';
import type { ItemRef } from '../types.js';
import type { Lesson } from './types.js';

/** Phase 21: a lesson's progress in the shared terms (Learned / Mastered over `lessonCoreItems`). */
export interface LessonProgress extends LearnedMastered {
  lessonId: string;
  grammarTotal: number;
  grammarMastered: number;
  /** Phase 25: points with at least one answer (right or wrong). */
  grammarPractised: number;
  scenariosTotal: number;
  scenariosDone: number;
  promptsTotal: number;
  promptsDone: number;
}

export interface LessonProgressInputs {
  index: ProgressIndex;
  completedScenarioIds?: ReadonlySet<string>;
  donePromptIds?: ReadonlySet<string>;
}

/** The items a lesson's numbers count: its core items, minus words the learner removed (Phase 20). */
export function countedLessonItems(lesson: Lesson, index: ProgressIndex): ItemRef[] {
  return lessonCoreItems(lesson).filter((i) => !index.removed(i));
}

export function lessonProgress(lesson: Lesson, inputs: LessonProgressInputs): LessonProgress {
  const items = countedLessonItems(lesson, inputs.index);
  const sum = inputs.index.summarize(items);
  const grammar = items.filter((i) => i.kind === 'grammar');
  return {
    ...sum,
    lessonId: lesson.id,
    grammarTotal: grammar.length,
    grammarMastered: grammar.filter((g) => inputs.index.mastered(g)).length,
    grammarPractised: grammar.filter((g) => !!inputs.index.grammarUse(g.id) || inputs.index.learned(g)).length,
    scenariosTotal: lesson.scenarios.length,
    scenariosDone: lesson.scenarios.filter((s) => inputs.completedScenarioIds?.has(s)).length,
    promptsTotal: lesson.journalPrompts.length,
    promptsDone: lesson.journalPrompts.filter((p) => inputs.donePromptIds?.has(p.id)).length,
  };
}

/** "Lesson done" = Mastered at the lesson share (the same rule as Home's celebration). */
export function lessonDone(p: Pick<LearnedMastered, 'masteredShare'>, share: number = PROGRESS_CONFIG.mastered.lessonShare): boolean {
  return p.masteredShare >= share;
}
