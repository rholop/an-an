// Phase 24: graded stories. The budget per difficulty, the prompt word lists, the validator (rung
// shares, Taiwan / traditional, length), regeneration feedback, comprehension-question checks and
// the library helpers. Pure: no fetch, no storage; time is injected.

import type { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import { segment } from '../segment.js';
import { checkTaiwanness, type TaiwannessResult } from '../taiwanness.js';
import { glossFor } from '../gloss/context.js';
import { hashText } from '../hash.js';
import { isOpenChatAllowedWord } from '../chat/openChat.js';
import { bestRung, type VocabLadder, type VocabRung } from '../progress/vocabLadder.js';
import { STORY_BUDGETS, STORY_CONFIG, type RungBudget, type StoryDifficulty } from './stories.config.js';
import type { StoryCheckRequest, StoryCheckResponse, StoryQuestion, StoryRequest, StoryResponse } from './types.js';
import type { ProviderName } from '../journal/types.js';

export * from './stories.config.js';
export * from './types.js';

export const storyBudget = (d: StoryDifficulty = 'middle'): RungBudget => STORY_BUDGETS[d];
export const storyLength = (level: Level): { min: number; max: number } => STORY_CONFIG.length[level];

/** Han characters in a text (what "You read 214 characters" counts). */
export const hanCount = (text: string): number => [...text].filter((c) => /\p{Script=Han}/u.test(c)).length;

/** Sentences of a paragraph (kept with their end punctuation). */
export function storySentences(paragraph: string): string[] {
  return paragraph.match(/[^。！？!?]+[。！？!?」』”]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

// ---------------------------------------------------------------------------------------------
// The prompt's word lists

export interface StoryPromptInput {
  ladder: VocabLadder;
  lexicon: Pick<Lexicon, 'byId'>;
  /** Due now: they lead rung 1 (reading them is review). */
  dueIds?: ReadonlySet<string>;
  /** Recently learned word ids, newest first. */
  recentIds?: readonly string[];
  /** For the rung 1 / rung 5 sample. */
  rng?: () => number;
}

/** Headwords per rung for the prompt: all of rungs 2–4, up to 300 of rung 1 (due and recent first). */
export function storyPromptRungs(input: StoryPromptInput): StoryRequest['rungs'] {
  const hw = (ids: Iterable<string>) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const h = input.lexicon.byId(id)?.headword;
      if (h && !seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
    return out;
  };
  const r1 = input.ladder.ids[1];
  const rng = input.rng ?? Math.random;
  const lead = [...(input.dueIds ?? [])].filter((id) => r1.has(id));
  const recent = (input.recentIds ?? []).filter((id) => r1.has(id));
  const rest = shuffle([...r1].filter((id) => !lead.includes(id) && !recent.includes(id)), rng);
  return {
    r1: hw([...lead, ...recent, ...rest]).slice(0, STORY_CONFIG.promptRung1Max),
    r2: hw(input.ladder.ids[2]),
    r3: hw(input.ladder.ids[3]),
    r4: hw(input.ladder.ids[4]),
    r5: shuffle(hw(input.ladder.ids[5]), rng).slice(0, STORY_CONFIG.promptRung5Max),
  };
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  const c = [...a];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [c[i], c[j]] = [c[j]!, c[i]!];
  }
  return c;
}

/** The budget as the prompt states it (Easier asks for no rung 4–5 words at all). */
export const promptBudget = (b: RungBudget): StoryRequest['budget'] => ({
  rung1Share: b.targetRung1Share,
  rung3: b.maxRung3Words,
  rung4: b.maxRung4Words,
  rung5: b.maxRung5Words,
});

/** Stable key of a story request (feedback left out): the same request is never paid for twice. */
export function storyRequestKey(req: Omit<StoryRequest, 'feedback'> & { difficulty?: StoryDifficulty; seriesId?: string; variant?: number }): string {
  const { rungs, ...rest } = req as StoryRequest & { difficulty?: StoryDifficulty };
  const norm = JSON.stringify({
    ...rest,
    feedback: undefined,
    rungs: { r1: [...rungs.r1].sort(), r2: [...rungs.r2].sort(), r3: [...rungs.r3].sort(), r4: [...rungs.r4].sort(), r5: [...rungs.r5].sort() },
  });
  return `story-${hashText(norm)}`;
}

// ---------------------------------------------------------------------------------------------
// Validation

export interface StoryToken {
  text: string;
  /** 'allowed': names, particles, numbers, punctuation (never counted). */
  rung: VocabRung | 'allowed';
  wordId?: string;
  /** Rung 6 word the story glosses inline. */
  glossed?: boolean;
}

export interface StoryContext {
  ladder: Pick<VocabLadder, 'rung'>;
  lexicon: Lexicon;
  /** Names the learner has met, the story's characters: always allowed. */
  allowedTexts?: ReadonlySet<string>;
  /** Words the story glosses inline (rung 6 only allowed so). */
  glossed?: ReadonlySet<string>;
}

export type StoryFailure = 'rung1' | 'rung3' | 'rung4' | 'rung5' | 'rung6' | 'taiwanness' | 'length' | 'questions';

export interface StoryReport {
  pass: boolean;
  failed: StoryFailure[];
  /** Tokens per paragraph. */
  paragraphs: StoryToken[][];
  contentTokens: number;
  rung1Share: number;
  /** Content tokens per rung. */
  counts: Record<VocabRung, number>;
  /** Distinct words per rung (word id, or the text for words outside the lexicon). */
  distinct: Record<VocabRung, string[]>;
  chars: number;
  /** Phase 25: shorter than the target but long enough to show (regenerate once, then accept). */
  short?: boolean;
  /** Sentences with simplified characters or mainland terms. */
  taiwanness: { sentence: string; result: TaiwannessResult }[];
}

const RUNGS: VocabRung[] = [1, 2, 3, 4, 5, 6];

/** Segments a paragraph, keeping each allowed name (小美, 王先生) whole even when the lexicon would split it. */
export function segmentWithNames(
  text: string,
  lexicon: Lexicon,
  names?: ReadonlySet<string>,
): Array<{ kind: string; text: string }> {
  const list = [...(names ?? [])].filter((n) => n.length > 1).sort((a, b) => b.length - a.length);
  if (list.length === 0) return segment(text, lexicon);
  const out: Array<{ kind: string; text: string }> = [];
  let rest = '';
  for (let i = 0; i < text.length; ) {
    const hit = list.find((n) => text.startsWith(n, i));
    if (hit) {
      if (rest) out.push(...segment(rest, lexicon));
      rest = '';
      out.push({ kind: 'word', text: hit });
      i += hit.length;
    } else {
      rest += text[i];
      i++;
    }
  }
  if (rest) out.push(...segment(rest, lexicon));
  return out;
}

/** Names a story may use freely: the learner's known names, plus the story's own characters when
 * they are not ordinary words (a model can't make 咖啡 "a character" to dodge the shares). */
export function storyAllowedNames(names: readonly string[], characters: readonly string[], lexicon: Pick<Lexicon, 'lookup'>): Set<string> {
  const out = new Set(names.map((n) => n.trim()).filter(Boolean));
  for (const c of characters.map((x) => x.trim())) {
    if (!c || /[^\p{Script=Han}·]/u.test(c) || c.length > 4) continue;
    const words = lexicon.lookup(c);
    if (words.length === 0 || words.every((w) => isOpenChatAllowedWord(w.tags))) out.add(c);
  }
  return out;
}

type RungOf = (text: string) => { rung: VocabRung | 'allowed'; id?: string };

/**
 * Phase 25: the rung of a piece of story text. Names and particles are 'allowed'; a lexicon word
 * takes its best ladder rung; a word on no rung that splits into ladder words takes the highest
 * rung of its parts (不是 = 不 + 是, 好吃 = 好 + 吃), so a compound of known words is not "unknown".
 */
function storyRungOf(ctx: StoryContext): RungOf {
  const memo = new Map<string, ReturnType<RungOf>>();
  const of: RungOf = (text) => {
    const hit = memo.get(text);
    if (hit) return hit;
    let res: ReturnType<RungOf>;
    if (ctx.allowedTexts?.has(text)) res = { rung: 'allowed' };
    else {
      const cands = ctx.lexicon.lookup(text);
      if (cands.some((w) => isOpenChatAllowedWord(w.tags))) res = { rung: 'allowed', id: cands[0]!.id };
      else {
        res = bestRung(ctx.ladder, cands.map((w) => w.id));
        if (res.rung === 6 && [...text].length > 1) {
          const split = splitRung(text, of);
          if (split !== undefined && split < 6) res = { rung: split, ...(res.id ? { id: res.id } : {}) };
        }
      }
    }
    memo.set(text, res);
    return res;
  };
  return of;
}

/** The lowest "highest rung" over the ways `text` splits into two or more ladder pieces. */
function splitRung(text: string, of: RungOf): VocabRung | undefined {
  const chars = [...text];
  let best: VocabRung | undefined;
  for (let i = 1; i < chars.length; i++) {
    const head = of(chars.slice(0, i).join(''));
    const tailText = chars.slice(i).join('');
    const tail = of(tailText);
    const hr = head.rung === 'allowed' ? 1 : head.rung;
    const tr = tail.rung === 'allowed' ? 1 : tail.rung;
    if (hr === 6 || tr === 6) continue;
    const r = Math.max(hr, tr) as VocabRung;
    if (best === undefined || r < best) best = r;
  }
  return best;
}

/**
 * Phase 25: the segmenter's longest-match can split a story wrongly (做工作 → 做工 + 作). Each run of
 * Chinese words is re-split to put as few words as possible on rung 6, then use as few words as possible.
 */
function resegmentStory(
  tokens: Array<{ kind: string; text: string }>,
  ctx: StoryContext,
  of: RungOf,
): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(...bestSplit(run.join(''), ctx.lexicon, of));
    run = [];
  };
  for (const t of tokens) {
    const isRun = (t.kind === 'word' || t.kind === 'unknown') && !ctx.allowedTexts?.has(t.text) && /^\p{Script=Han}+$/u.test(t.text);
    if (isRun) run.push(t.text);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

function bestSplit(text: string, lexicon: Lexicon, of: RungOf): Array<{ kind: string; text: string }> {
  const chars = [...text];
  const n = chars.length;
  const max = Math.max(1, lexicon.maxHeadwordLength);
  // cost[i] = best [rung-6 words, words] for chars[i..]
  const cost: Array<[number, number]> = new Array(n + 1);
  const cut: number[] = new Array(n + 1);
  cost[n] = [0, 0];
  for (let i = n - 1; i >= 0; i--) {
    let best: [number, number] | undefined;
    for (let l = Math.min(max, n - i); l >= 1; l--) {
      const piece = chars.slice(i, i + l).join('');
      if (l > 1 && lexicon.lookup(piece).length === 0) continue;
      const r = of(piece).rung;
      const rest = cost[i + l]!;
      const c: [number, number] = [rest[0] + (r === 6 ? 1 : 0), rest[1] + 1];
      if (!best || c[0] < best[0] || (c[0] === best[0] && c[1] < best[1])) {
        best = c;
        cut[i] = l;
      }
    }
    cost[i] = best!;
  }
  const res: Array<{ kind: string; text: string }> = [];
  for (let i = 0; i < n; i += cut[i]!) {
    const piece = chars.slice(i, i + cut[i]!).join('');
    res.push({ kind: lexicon.lookup(piece).length > 0 ? 'word' : 'unknown', text: piece });
  }
  return res;
}

/** Classifies every token of the story and checks Part A's shares, Taiwan / traditional and length. */
export function analyzeStory(
  paragraphs: readonly string[],
  ctx: StoryContext,
  budget: RungBudget = storyBudget('middle'),
  length?: { min: number; max: number },
): StoryReport {
  const out: StoryToken[][] = [];
  const rungOf = storyRungOf(ctx);
  for (const p of paragraphs) {
    const toks: StoryToken[] = [];
    for (const t of resegmentStory(segmentWithNames(p, ctx.lexicon, ctx.allowedTexts), ctx, rungOf)) {
      if (t.kind !== 'word' && t.kind !== 'unknown') continue; // numbers, latin, punctuation
      const best = rungOf(t.text);
      if (best.rung === 'allowed') {
        toks.push({ text: t.text, rung: 'allowed', ...(best.id ? { wordId: best.id } : {}) });
        continue;
      }
      const tok: StoryToken = { text: t.text, rung: best.rung, ...(best.id ? { wordId: best.id } : {}) };
      if (best.rung === 6 && ctx.glossed?.has(t.text)) tok.glossed = true;
      toks.push(tok);
    }
    out.push(toks);
  }
  const all = out.flat();
  const counts = Object.fromEntries(RUNGS.map((r) => [r, 0])) as Record<VocabRung, number>;
  const distinctSets = Object.fromEntries(RUNGS.map((r) => [r, new Set<string>()])) as Record<VocabRung, Set<string>>;
  for (const t of all) {
    if (t.rung === 'allowed') continue;
    counts[t.rung]++;
    distinctSets[t.rung].add(t.wordId ?? t.text);
  }
  const distinct = Object.fromEntries(RUNGS.map((r) => [r, [...distinctSets[r]]])) as Record<VocabRung, string[]>;
  const contentTokens = RUNGS.reduce((n, r) => n + counts[r], 0);
  // Phase 25: a glossed word is explained where it stands, so it does not count against the share
  // (the rung 6 limit still caps how many there are).
  const glossedTokens = all.filter((t) => t.glossed).length;
  const shareBase = contentTokens - glossedTokens;
  const rung1Share = shareBase <= 0 ? 1 : counts[1] / shareBase;
  const chars = paragraphs.reduce((n, p) => n + hanCount(p), 0);

  const taiwanness = paragraphs
    .flatMap(storySentences)
    .map((sentence) => ({ sentence, result: checkTaiwanness(sentence) }))
    .filter((x) => !x.result.isClean);

  const failed: StoryFailure[] = [];
  let short = false;
  if (rung1Share < budget.minRung1Share) failed.push('rung1');
  if (distinct[3].length > budget.maxRung3Words) failed.push('rung3');
  if (distinct[4].length > budget.maxRung4Words) failed.push('rung4');
  if (distinct[5].length > budget.maxRung5Words) failed.push('rung5');
  const unglossed6 = all.filter((t) => t.rung === 6 && !t.glossed);
  if (unglossed6.length > 0 || distinct[6].length > budget.maxRung6Glossed) failed.push('rung6');
  if (taiwanness.length > 0) failed.push('taiwanness');
  if (length) {
    const slack = STORY_CONFIG.lengthSlack;
    if (chars < length.min * STORY_CONFIG.minLengthShare || chars > length.max * (1 + slack)) failed.push('length');
    else if (chars < length.min * (1 - slack)) short = true;
  }
  return {
    pass: failed.length === 0,
    failed,
    paragraphs: out,
    contentTokens,
    rung1Share,
    counts,
    distinct,
    chars,
    ...(short ? { short } : {}),
    taiwanness,
  };
}

/** Rung 1 words that could stand in for an over-budget word (a shared English gloss word). */
export function simplerSwaps(
  wordId: string,
  ladder: Pick<VocabLadder, 'ids'>,
  lexicon: Pick<Lexicon, 'byId'>,
  max = 2,
): string[] {
  const w = lexicon.byId(wordId);
  if (!w) return [];
  const STOP = new Set(['to', 'a', 'an', 'the', 'of', 'be', 'one', 'in', 'on', 'for', 'and', 'or', 'sb', 'sth']);
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((x) => x.length > 2 && !STOP.has(x)));
  const mine = words(glossFor(w, { textbook: false }));
  if (mine.size === 0) return [];
  const out: string[] = [];
  for (const id of ladder.ids[1]) {
    const o = lexicon.byId(id);
    if (!o || o.headword === w.headword) continue;
    if ([...words(glossFor(o, { textbook: false }))].some((x) => mine.has(x))) out.push(o.headword);
    if (out.length >= max) break;
  }
  return out;
}

/** Regeneration feedback (the Phase 3 / 18 pattern): the over-budget words and simpler swaps. */
export function storyFeedback(
  report: StoryReport,
  budget: RungBudget,
  ctx: { ladder: Pick<VocabLadder, 'ids'>; lexicon: Pick<Lexicon, 'byId'> },
): string {
  const parts: string[] = [];
  const name = (idOrText: string) => ctx.lexicon.byId(idOrText)?.headword ?? idOrText;
  const withSwaps = (ids: string[]) =>
    ids
      .slice(0, 10)
      .map((id) => {
        const s = simplerSwaps(id, ctx.ladder, ctx.lexicon);
        return s.length > 0 ? `${name(id)} (try ${s.join(' / ')})` : name(id);
      })
      .join('、');
  if (report.failed.includes('rung1'))
    parts.push(
      `Only ${(report.rung1Share * 100).toFixed(0)}% of the words are from the known list (rung 1); it must be at least ${(budget.minRung1Share * 100).toFixed(0)}%. Replace words outside the lists: ${withSwaps([...report.distinct[5], ...report.distinct[6], ...report.distinct[4]])}.`,
    );
  if (report.failed.includes('rung3'))
    parts.push(`Too many next-lesson words (at most ${budget.maxRung3Words}): ${withSwaps(report.distinct[3])}.`);
  if (report.failed.includes('rung4'))
    parts.push(`At most ${budget.maxRung4Words} word from the lesson after: ${withSwaps(report.distinct[4])}.`);
  if (report.failed.includes('rung5'))
    parts.push(`At most ${budget.maxRung5Words} level word outside the lessons: ${withSwaps(report.distinct[5])}.`);
  if (report.failed.includes('rung6'))
    parts.push(`These words are in none of the lists; leave them out (or gloss a necessary name in "glosses"): ${withSwaps(report.distinct[6])}.`);
  if (report.failed.includes('taiwanness'))
    parts.push(
      `Use Taiwan Mandarin in traditional characters only: ${report.taiwanness
        .flatMap((t) => [...t.result.simplifiedChars.map((c) => c.char), ...t.result.mainlandTerms.map((m) => `${m.matched} → ${m.taiwan}`)])
        .slice(0, 8)
        .join('、')}.`,
    );
  if (report.short) parts.push(`The story has only ${report.chars} characters; write a little more, up to the target length.`);
  if (report.failed.includes('length')) parts.push(`The story has ${report.chars} characters; keep to the target length.`);
  parts.push('Write the story again with simpler words from rung 1. Keep the same characters and topic.');
  return parts.join(' ');
}

/** Of several attempts, the one that breaks the fewest limits (then the highest rung 1 share). */
export function pickBestStoryAttempt<T extends { report: StoryReport }>(attempts: readonly T[]): T {
  return [...attempts].sort(
    (x, y) =>
      Number(y.report.pass) - Number(x.report.pass) ||
      x.report.failed.length - y.report.failed.length ||
      Number(!!x.report.short) - Number(!!y.report.short) ||
      y.report.rung1Share - x.report.rung1Share,
  )[0]!;
}

// ---------------------------------------------------------------------------------------------
// Comprehension questions

export interface QuestionCheck {
  ok: boolean;
  /** The questions to show (well-formed, one right answer each), at most `questions.max`. */
  questions: StoryQuestion[];
  problems: string[];
}

/**
 * Each question needs 3–4 distinct options and exactly one right answer: its own `answer`, and
 * (when the independent check is given) the only option the checker found correct.
 */
export function checkStoryQuestions(questions: readonly StoryQuestion[], check?: Pick<StoryCheckResponse, 'correctOptions'>): QuestionCheck {
  const cfg = STORY_CONFIG.questions;
  const problems: string[] = [];
  const kept: StoryQuestion[] = [];
  questions.forEach((q, i) => {
    const opts = q.options.map((o) => o.zh.trim());
    if (opts.length < cfg.optionsMin || opts.length > cfg.optionsMax) return void problems.push(`Question ${i + 1}: ${opts.length} options.`);
    if (new Set(opts).size !== opts.length) return void problems.push(`Question ${i + 1}: two options are the same.`);
    if (q.answer < 0 || q.answer >= opts.length) return void problems.push(`Question ${i + 1}: the answer is not one of the options.`);
    if (!checkTaiwanness(`${q.q_zh}${opts.join('')}`).isClean) return void problems.push(`Question ${i + 1}: not Taiwan Mandarin.`);
    if (check) {
      const right = [...new Set(check.correctOptions[i] ?? [])];
      if (right.length !== 1 || right[0] !== q.answer)
        return void problems.push(`Question ${i + 1}: the independent reader found ${right.length === 0 ? 'no' : right.join(', ')} correct, not only ${q.answer}.`);
    }
    if (kept.length < cfg.max) kept.push(q);
  });
  const ok = kept.length >= cfg.min;
  if (!ok) problems.push(`Only ${kept.length} good question(s); need ${cfg.min}.`);
  return { ok, questions: kept, problems };
}

/** The independent reader approved the story. */
export const storyCheckPasses = (c: StoryCheckResponse): boolean => c.natural && c.coherent && c.taiwan && c.summaryMatches;

/** What the independent reader is given: the story and its questions, never the prompt or lists. */
export function storyCheckRequest(s: Pick<StoryResponse, 'paragraphs' | 'summary_en' | 'questions'>) {
  return {
    paragraphs: s.paragraphs.map((p) => p.zh),
    summaryEn: s.summary_en,
    questions: s.questions.map((q) => ({ q: q.q_zh, options: q.options.map((o) => o.zh) })),
  };
}

// ---------------------------------------------------------------------------------------------
// The library

/** A saved story (per profile, synced). Rung words are kept so reading can underline them. */
/** What the web app needs from the proxy for stories (implemented by apps/web's FetchTutorLLM). */
export interface StoryLLM {
  writeStory(req: StoryRequest): Promise<{ story: StoryResponse; servedBy?: ProviderName }>;
  checkStory(req: StoryCheckRequest): Promise<StoryCheckResponse>;
}

export interface StoryRecord {
  /** `storyRequestKey`: the same request is never generated twice. */
  id: string;
  createdAt: Date;
  updatedAt: Date;
  level: Level;
  difficulty: StoryDifficulty;
  topic: string;
  /** The lesson it was written for (the active lesson then). */
  lessonId?: string;
  /** "Continue a story": one series, episode 1, 2, … */
  seriesId?: string;
  episode?: number;
  titleZh: string;
  titleEn: string;
  paragraphs: { zh: string; en: string }[];
  summaryEn: string;
  glosses: { zh: string; en: string }[];
  characters: string[];
  questions: StoryQuestion[];
  /** Word ids by rung (2–6) when it was written: underlined while reading, listed afterwards. */
  newWords: { wordId?: string; text: string; rung: VocabRung }[];
  /** Content word ids in the story (for "easier now"). */
  wordIds: string[];
  chars: number;
  rung1Share: number;
  /** Set when finished. */
  readAt?: Date;
  /** Comprehension: right answers / questions. */
  score?: { right: number; of: number };
  readCount?: number;
  /** Every time it was finished (for "characters read this week"). */
  readDates?: Date[];
  /** "Something's wrong": a reported story leaves the library and is never suggested again. */
  report?: { reason: string; note?: string; at: Date };
}

/** Words to underline and list afterwards: rungs 2–6, once each. */
export function storyNewWords(report: StoryReport): StoryRecord['newWords'] {
  const seen = new Set<string>();
  const out: StoryRecord['newWords'] = [];
  for (const t of report.paragraphs.flat()) {
    if (t.rung === 'allowed' || t.rung === 1) continue;
    const k = t.wordId ?? t.text;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...(t.wordId ? { wordId: t.wordId } : {}), text: t.text, rung: t.rung });
  }
  return out;
}

/** A story record from an accepted response and its report. */
export function storyRecord(
  res: StoryResponse,
  report: StoryReport,
  questions: StoryQuestion[],
  meta: Pick<StoryRecord, 'id' | 'level' | 'difficulty' | 'topic' | 'lessonId' | 'seriesId' | 'episode'>,
  now: Date,
): StoryRecord {
  const wordIds = [...new Set(report.paragraphs.flat().flatMap((t) => (t.rung !== 'allowed' && t.wordId ? [t.wordId] : [])))];
  return {
    ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
    id: meta.id,
    level: meta.level,
    difficulty: meta.difficulty,
    topic: meta.topic,
    createdAt: now,
    updatedAt: now,
    titleZh: res.title_zh,
    titleEn: res.title_en,
    paragraphs: res.paragraphs,
    summaryEn: res.summary_en,
    glosses: res.glosses,
    characters: res.characters,
    questions,
    newWords: storyNewWords(report),
    wordIds,
    chars: report.chars,
    rung1Share: report.rung1Share,
  };
}

/** Share of a story's words the learner knows now (for "You'll find this one easier now"). */
export function knownShareNow(s: Pick<StoryRecord, 'wordIds'>, knownIds: ReadonlySet<string>): number {
  if (s.wordIds.length === 0) return 1;
  return s.wordIds.filter((id) => knownIds.has(id)).length / s.wordIds.length;
}

/** Older read stories that are now mostly known words: suggested again. */
export function rereadSuggestions(stories: readonly StoryRecord[], knownIds: ReadonlySet<string>, now: Date): StoryRecord[] {
  const cfg = STORY_CONFIG.reread;
  return stories
    .filter((s) => s.readAt && now.getTime() - s.readAt.getTime() >= cfg.minAgeDays * 86_400_000)
    .filter((s) => s.rung1Share < 1 && knownShareNow(s, knownIds) >= Math.max(cfg.minLearnedShare, s.rung1Share))
    .sort((a, b) => a.readAt!.getTime() - b.readAt!.getTime())
    .slice(0, cfg.maxSuggestions);
}

/** Minutes to read at Novice pace (at least 1). */
/** "Characters read this week": every finish since `since` counts its characters. */
export function storyReadingStats(stories: readonly Pick<StoryRecord, 'chars' | 'readDates' | 'readAt'>[], since: Date): { chars: number; finished: number } {
  let chars = 0;
  let finished = 0;
  for (const s of stories) {
    const dates = s.readDates ?? (s.readAt ? [s.readAt] : []);
    const n = dates.filter((d) => d.getTime() >= since.getTime()).length;
    chars += n * s.chars;
    finished += n;
  }
  return { chars, finished };
}

export const storyMinutes = (chars: number): number => Math.max(1, Math.round(chars / STORY_CONFIG.charsPerMinute));
export * from './pipeline.js';
export * from './dry.js';
