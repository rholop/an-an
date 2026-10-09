import type { GrammarStepExercise } from '@anan/core';

export type GrammarExercise = GrammarStepExercise;

// Phase 25: the lesson grammar step's builders live in core (the curriculum audit uses them too).
export { buildLessonGrammarStep, buildSingleGrammarExercise, type LessonGrammarStep } from '@anan/core';
