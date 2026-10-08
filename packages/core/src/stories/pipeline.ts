// Phase 24: the whole write → validate → regenerate once → independent check pipeline, shared by
// the web app's StoryService and the offline eval (apps/proxy/scripts/stories-eval.ts).
import type { Lexicon } from '../lexicon.js';
import { checkTaiwanness } from '../taiwanness.js';
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
  | { ok: true; story: StoryResponse; report: StoryReport; questions: StoryQuestion[]; attempts: StoryAttempt[]; check: StoryCheckResponse }
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
    if (a.report.pass) break;
    feedback = [storyFeedback(a.report, budget, { ladder: input.ladder, lexicon: input.lexicon }), ...a.problems]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500);
  }
  const best = pickBestStoryAttempt(attempts);
  if (!best.report.pass) return { ok: false, reasons: best.report.failed, attempts };

  // The independent reader: a fresh call on the checker model, shown only the story, its summary and questions.
  const checked = { ...best.res, questions: best.questions };
  const check = await input.llm.checkStory(storyCheckRequest(checked));
  if (!storyCheckPasses(check)) return { ok: false, reasons: ['independent check', ...check.problems], attempts, check };
  const agreed = checkStoryQuestions(best.questions, check).questions;
  if (agreed.length < STORY_CONFIG.questions.min) return { ok: false, reasons: ['questions'], attempts, check };
  return { ok: true, story: checked, report: best.report, questions: agreed, attempts, check };
}
