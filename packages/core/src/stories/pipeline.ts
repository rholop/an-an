// Phase 24: the whole write → validate → regenerate once → independent check pipeline, shared by
// the web app's StoryService and the offline eval (apps/proxy/scripts/stories-eval.ts).
import type { Lexicon } from '../lexicon.js';
import { checkTaiwanness } from '../taiwanness.js';
import { glossFor } from '../gloss/context.js';
import type { VocabLadder } from '../progress/vocabLadder.js';
import {
  analyzeStory,
  checkStoryQuestions,
  pickBestStoryAttempt,
  storyAllowedNames,
  storyBudget,
  storyCheckPasses,
  storyCheckRequest,
  storyFeedback,
  type StoryLLM,
  type StoryReport,
} from './index.js';
import { STORY_CONFIG, type StoryDifficulty } from './stories.config.js';
import type { StoryCheckResponse, StoryQuestion, StoryRequest, StoryResponse } from './types.js';

const clean = (zh: string): boolean => checkTaiwanness(zh).isClean;

export interface StoryAttempt {
  res: StoryResponse;
  servedBy?: string;
  report: StoryReport;
  questions: StoryQuestion[];
  problems: string[];
}

export type StoryPipelineResult =
  | {
      ok: true;
      story: StoryResponse;
      report: StoryReport;
      questions: StoryQuestion[];
      attempts: StoryAttempt[];
      check: StoryCheckResponse;
      /** Phase 25: shown although it missed the word budgets, every unknown word explained. */
      miniLesson?: boolean;
    }
  | { ok: false; reasons: string[]; attempts: StoryAttempt[]; check?: StoryCheckResponse };

/** Code checks on one written story: rung shares, Taiwan / traditional, length, title and questions. */
export function analyzeStoryResponse(
  res: StoryResponse,
  ctx: { req: StoryRequest; ladder: VocabLadder; lexicon: Lexicon; difficulty: StoryDifficulty },
): Omit<StoryAttempt, 'res' | 'servedBy'> {
  const allowedTexts = storyAllowedNames(ctx.req.names, res.characters, ctx.lexicon);
  const glossed = new Set(res.glosses.map((g) => g.zh));
  const report = analyzeStory(
    res.paragraphs.map((p) => p.zh),
    { ladder: ctx.ladder, lexicon: ctx.lexicon, allowedTexts, glossed },
    storyBudget(ctx.difficulty),
    ctx.req.length,
  );
  const qc = checkStoryQuestions(res.questions.filter((q) => clean(q.q_zh) && q.options.every((o) => clean(o.zh))));
  const problems = [...qc.problems];
  if (qc.questions.length < STORY_CONFIG.questions.min) {
    problems.push(`Write ${STORY_CONFIG.questions.min}–${STORY_CONFIG.questions.max} questions, each with exactly one right option.`);
    if (!report.failed.includes('questions')) report.failed.push('questions');
  }
  if (!clean(res.title_zh)) {
    problems.push('The title must be traditional characters and Taiwan usage.');
    if (!report.failed.includes('taiwanness')) report.failed.push('taiwanness');
  }
  report.pass = report.failed.length === 0;
  return { report, questions: qc.questions, problems };
}

export async function runStoryPipeline(input: {
  llm: StoryLLM;
  req: StoryRequest;
  ladder: VocabLadder;
  lexicon: Lexicon;
  difficulty: StoryDifficulty;
}): Promise<StoryPipelineResult> {
  const budget = storyBudget(input.difficulty);
  const attempts: StoryAttempt[] = [];
  let feedback: string | undefined;
  while (attempts.length <= STORY_CONFIG.maxRegenerations) {
    const { story, servedBy } = await input.llm.writeStory({ ...input.req, ...(feedback ? { feedback } : {}) });
    const a = analyzeStoryResponse(story, input);
    attempts.push({ res: story, ...(servedBy ? { servedBy } : {}), ...a });
    // Phase 25: a short story is asked for once more, then shown anyway.
    if (a.report.pass && !a.report.short) break;
    feedback = [storyFeedback(a.report, budget, { ladder: input.ladder, lexicon: input.lexicon }), ...a.problems]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500);
  }
  const best = pickBestStoryAttempt(attempts);
  const lesson = best.report.pass ? undefined : miniLessonGlosses(best, input.lexicon);
  if (!best.report.pass && !lesson) return { ok: false, reasons: best.report.failed, attempts };

  // The independent reader: a fresh call on the checker model, shown only the story, its summary and questions.
  const checked = { ...best.res, questions: best.questions, ...(lesson ? { glosses: lesson } : {}) };
  const check = await input.llm.checkStory(storyCheckRequest(checked));
  if (!storyCheckPasses(check)) return { ok: false, reasons: ['independent check', ...check.problems], attempts, check };
  const agreed = checkStoryQuestions(best.questions, check).questions;
  if (agreed.length < STORY_CONFIG.questions.min) return { ok: false, reasons: ['questions'], attempts, check };
  return { ok: true, story: checked, report: best.report, questions: agreed, attempts, check, ...(lesson ? { miniLesson: true } : {}) };
}

const VOCAB_FAILURES = new Set(['rung1', 'rung3', 'rung4', 'rung5', 'rung6']);

/**
 * Phase 25: a story that failed only on the word budgets (Taiwan usage, length and questions all
 * fine) becomes a mini lesson: still mostly known words, a handful of new ones, each explained.
 * Returns the story's glosses plus one for every new word, or undefined when it can't be shown.
 */
export function miniLessonGlosses(
  a: Pick<StoryAttempt, 'res' | 'report'>,
  lexicon: Pick<Lexicon, 'byId'>,
): StoryResponse['glosses'] | undefined {
  const cfg = STORY_CONFIG.miniLesson;
  if (!a.report.failed.every((f) => VOCAB_FAILURES.has(f))) return undefined;
  if (a.report.rung1Share < cfg.minRung1Share) return undefined;
  const glosses = [...a.res.glosses];
  const have = new Set(glosses.map((g) => g.zh));
  let fresh = 0;
  const seen = new Set<string>();
  for (const t of a.report.paragraphs.flat()) {
    // rung 2 is the lesson being studied: practice, not new
    if (t.rung === 'allowed' || t.rung === 1 || t.rung === 2 || seen.has(t.text)) continue;
    seen.add(t.text);
    fresh++;
    if (have.has(t.text)) continue;
    const word = t.wordId ? lexicon.byId(t.wordId) : undefined;
    const en = word ? glossFor(word, { textbook: false }) : '';
    if (!en) return undefined; // a word nobody can explain: not shown
    glosses.push({ zh: t.text, en: en.slice(0, 80) });
    have.add(t.text);
  }
  if (fresh > cfg.maxNewWords) return undefined;
  return glosses;
}
