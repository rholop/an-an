// Phase 24/26: the whole write → validate → repair → independent check pipeline, shared by the web
// app's StoryService, the offline eval (apps/proxy/scripts/stories-eval.ts) and the lesson-story
// builder. Phase 26: problem sentences are repaired instead of the story being thrown away; a story
// that still misses the targets is shown as a mini lesson when it is above the floors. Only the hard
// rules refuse (Part D).
import type { Lexicon } from '../lexicon.js';
import { checkTaiwanness } from '../taiwanness.js';
import { glossFor } from '../gloss/context.js';
import type { VocabLadder, VocabRung } from '../progress/vocabLadder.js';
import {
  analyzeStory,
  applyStoryRepair,
  checkStoryQuestions,
  pickBestStoryAttempt,
  storyAllowedNames,
  storyBudget,
  storyCheckPasses,
  storyCheckRequest,
  storyFeedback,
  storyRepairRequest,
  storyUndeclaredWords,
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
  /** Phase 26: how this version was made. */
  via?: 'write' | 'rewrite' | 'repair';
}

/** Phase 26 Part F: what the page says while the pipeline runs. */
export type StoryStage = 'writing' | 'repairing' | 'checking';

export type StoryPipelineResult =
  | {
      ok: true;
      story: StoryResponse;
      report: StoryReport;
      questions: StoryQuestion[];
      attempts: StoryAttempt[];
      check: StoryCheckResponse;
      /** Shown although it missed the word targets: its new words are taught first. */
      miniLesson?: boolean;
      /** Model calls that wrote or repaired (the check is one more). */
      calls: number;
    }
  | { ok: false; reasons: string[]; attempts: StoryAttempt[]; check?: StoryCheckResponse; calls: number };

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
  // Phase 26 Part D: questions that fail are dropped one by one; they never refuse a story.
  const qc = checkStoryQuestions(res.questions.filter((q) => clean(q.q_zh) && q.options.every((o) => clean(o.zh))));
  const problems = [...qc.problems];
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
  onProgress?: (stage: StoryStage) => void;
}): Promise<StoryPipelineResult> {
  const budget = storyBudget(input.difficulty);
  const floor = STORY_CONFIG.miniLesson.floor[input.difficulty];
  const attempts: StoryAttempt[] = [];
  let calls = 0;
  let repairs = 0;
  let rewrites = 0;

  const analyze = (res: StoryResponse, via: StoryAttempt['via'], servedBy?: string): StoryAttempt => {
    const a = { res, ...(servedBy ? { servedBy } : {}), via, ...analyzeStoryResponse(res, input) };
    attempts.push(a);
    return a;
  };
  const write = async (feedback?: string): Promise<StoryAttempt> => {
    input.onProgress?.('writing');
    calls++;
    const fresh = feedback !== undefined || input.req.fresh;
    const { story, servedBy } = await input.llm.writeStory({ ...input.req, ...(feedback ? { feedback } : {}), ...(fresh ? { fresh: true } : {}) });
    return analyze(story, feedback === undefined ? 'write' : 'rewrite', servedBy);
  };

  let cur = await write();
  while (calls < STORY_CONFIG.maxWriteCalls) {
    const r = cur.report;
    if (r.pass && !r.short) break;
    const vocabOnly = r.failed.every((f) => f !== 'length') && r.knownShare >= floor && !r.short;
    // Sentence repair: only the sentences with a problem word (or a mainland / simplified form).
    if (vocabOnly && r.failed.length > 0 && repairs < STORY_CONFIG.maxRepairRounds) {
      const rq = storyRepairRequest(cur.res, r, budget, input);
      if (rq) {
        input.onProgress?.('repairing');
        calls++;
        repairs++;
        const fixed = await input.llm.repairStory(rq);
        cur = analyze(applyStoryRepair(cur.res, fixed, new Set(rq.sentences.map((x) => x.i))), 'repair');
        continue;
      }
    }
    // Too short, too long or mostly unknown words: one whole rewrite with feedback (a short story
    // that is otherwise fine is shown after that one try, Phase 25).
    if (rewrites >= 1 && (r.short || r.pass)) break;
    rewrites++;
    const undeclared = storyUndeclaredWords(r, cur.res);
    const feedback = [storyFeedback(r, budget, { ladder: input.ladder, lexicon: input.lexicon, undeclared }), ...cur.problems]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500);
    cur = await write(feedback || 'Write a different story on the same topic.');
  }

  const showable = attempts.filter((a) => a.report.pass || storyRefusals(a, input.lexicon, input.difficulty).length === 0);
  const best = pickBestStoryAttempt(showable.length ? showable : attempts);
  const refusals = best.report.pass ? [] : storyRefusals(best, input.lexicon, input.difficulty);
  if (refusals.length > 0) return { ok: false, reasons: refusals, attempts, calls };

  // Every word outside rungs 1–2 is glossed by code from the lexicon; a word outside the lexicon
  // keeps the writer's gloss only when the independent reader agrees with it.
  const { glosses, unverified } = storyWordGlosses(best, input.lexicon);
  input.onProgress?.('checking');
  const check = await input.llm.checkStory(storyCheckRequest({ ...best.res, questions: best.questions }, unverified));
  if (!storyCheckPasses(check)) return { ok: false, reasons: ['independent check', ...check.problems], attempts, check, calls };
  if (unverified.length > 0 && check.glossesOk !== true) return { ok: false, reasons: ['unexplained'], attempts, check, calls };
  const agreed = checkStoryQuestions(best.questions, check).questions;
  const story: StoryResponse = { ...best.res, questions: agreed, glosses: [...glosses, ...unverified] };
  return { ok: true, story, report: best.report, questions: agreed, attempts, check, calls, ...(best.report.pass ? {} : { miniLesson: true }) };
}

/**
 * Phase 26 Part D: why a story that missed its targets can't be shown (empty when it can, as a
 * mini lesson): simplified / mainland wording, length, the known-or-this-lesson share below the
 * floor, more new words than the mini lesson teaches, or a word nobody can explain.
 */
export function storyRefusals(
  a: Pick<StoryAttempt, 'res' | 'report'>,
  lexicon: Pick<Lexicon, 'byId'>,
  difficulty: StoryDifficulty = 'middle',
): string[] {
  const cfg = STORY_CONFIG.miniLesson;
  const out: string[] = [];
  if (a.report.failed.includes('taiwanness')) out.push('taiwanness');
  if (a.report.failed.includes('length')) out.push('length');
  if (a.report.knownShare < cfg.floor[difficulty]) out.push('rung1');
  if (miniLessonWordCount(a.report) > cfg.maxWords[difficulty]) out.push('new words');
  if (storyWordGlosses(a, lexicon).missing.length > 0) out.push('unexplained');
  return out;
}

/** Distinct words from rungs 3–6 (what the mini lesson teaches; rung 2 is the lesson itself). */
export function miniLessonWordCount(report: StoryReport): number {
  const seen = new Set<string>();
  for (const t of report.paragraphs.flat()) if (t.rung !== 'allowed' && t.rung >= 3) seen.add(t.wordId ?? t.text);
  return seen.size;
}

/**
 * Phase 26 C3: a gloss for every word from rungs 3–6. Lexicon words are glossed by code (textbook
 * sense for lesson words); a word outside the lexicon uses the writer's `newWords` / `glosses` entry,
 * to be confirmed by the checker (`unverified`), or is `missing`.
 */
export function storyWordGlosses(
  a: Pick<StoryAttempt, 'res' | 'report'>,
  lexicon: Pick<Lexicon, 'byId'>,
): { glosses: StoryResponse['glosses']; unverified: StoryResponse['glosses']; missing: string[] } {
  const model = new Map([...a.res.glosses, ...(a.res.newWords ?? [])].filter((g) => g.en.trim()).map((g) => [g.zh, g.en.trim()]));
  const glosses: StoryResponse['glosses'] = [];
  const unverified: StoryResponse['glosses'] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const t of a.report.paragraphs.flat()) {
    if (t.rung === 'allowed' || t.rung < 3 || seen.has(t.text)) continue;
    seen.add(t.text);
    const word = t.wordId ? lexicon.byId(t.wordId) : undefined;
    const en = word ? glossFor(word, { textbook: (t.rung as VocabRung) <= 4 }) : '';
    if (en) glosses.push({ zh: t.text, en: en.slice(0, 80) });
    else if (model.has(t.text)) unverified.push({ zh: t.text, en: model.get(t.text)!.slice(0, 80) });
    else missing.push(t.text);
  }
  return { glosses, unverified, missing };
}

/** Phase 25 name kept for callers: the glosses a mini lesson shows, or undefined when it can't be shown. */
export function miniLessonGlosses(
  a: Pick<StoryAttempt, 'res' | 'report'>,
  lexicon: Pick<Lexicon, 'byId'>,
  difficulty: StoryDifficulty = 'middle',
): StoryResponse['glosses'] | undefined {
  if (storyRefusals(a, lexicon, difficulty).length > 0) return undefined;
  const g = storyWordGlosses(a, lexicon);
  return [...g.glosses, ...g.unverified];
}
