import type { SkillCard } from '../learner/types.js';
import type { Lesson } from './types.js';

export interface LessonProgress {
  lessonId: string;
  vocabTotal: number;
  vocabInReview: number;
  /** vocabInReview / vocabTotal (1 for an empty list). */
  vocabShare: number;
  grammarTotal: number;
  /** Grammar items with a card past `introduced` (actually practised). */
  grammarPractised: number;
  scenariosTotal: number;
  scenariosDone: number;
  promptsTotal: number;
  promptsDone: number;
}

const IN_REVIEW = new Set(['review', 'mature']);
const PRACTISED = new Set(['learning', 'review', 'mature']);

export interface ProgressInputs {
  cards: readonly SkillCard[];
  completedScenarioIds?: ReadonlySet<string>;
  donePromptIds?: ReadonlySet<string>;
}

export function lessonProgress(lesson: Lesson, inputs: ProgressInputs): LessonProgress {
  const wordState = new Map<string, boolean>();
  const grammarState = new Map<string, boolean>();
  for (const c of inputs.cards) {
    if (c.item.kind === 'word' && c.skill === 'recognition') {
      if (IN_REVIEW.has(c.state)) wordState.set(c.item.id, true);
    } else if (c.item.kind === 'grammar' && PRACTISED.has(c.state)) {
      grammarState.set(c.item.id, true);
    }
  }
  const vocab = [...new Set(lesson.vocab)];
  const vocabInReview = vocab.filter((id) => wordState.get(id)).length;
  const grammarPractised = lesson.grammar.filter((id) => grammarState.get(id)).length;
  return {
    lessonId: lesson.id,
    vocabTotal: vocab.length,
    vocabInReview,
    vocabShare: vocab.length === 0 ? 1 : vocabInReview / vocab.length,
    grammarTotal: lesson.grammar.length,
    grammarPractised,
    scenariosTotal: lesson.scenarios.length,
    scenariosDone: lesson.scenarios.filter((s) => inputs.completedScenarioIds?.has(s)).length,
    promptsTotal: lesson.journalPrompts.length,
    promptsDone: lesson.journalPrompts.filter((p) => inputs.donePromptIds?.has(p.id)).length,
  };
}

/** "Lesson done" = core vocab (not supplementary) ≥ 80% in review. */
export function lessonDone(p: LessonProgress, threshold = 0.8): boolean {
  return p.vocabShare >= threshold;
}
