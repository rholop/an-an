import type { Lexicon } from '../lexicon.js';
import { resolveReading } from '../reading.js';
import { segment } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import type { Level, Word } from '../types.js';
import { extractBrackets, type BracketGap } from './bracket.js';
import { normalisePattern } from './error-bank.js';
import type {
  Alternative,
  GapOption,
  IssueExplanation,
  JournalExplainCheckRequest,
  JournalExplainCheckResponse,
  JournalGapRequest,
  JournalGapResponse,
  JournalIssue,
  JournalVerifyRequest,
  JournalVerifyResponse,
  JournalWhyRequest,
} from './types.js';

// Phase 31: corrections you can understand and question. Pure orchestration over an injected
// LLM (the web app's proxy client, or a fake in tests); every answer is validated here.

export interface ExplainLLM {
  /** The independent check of every explanation of an entry (the checker model). */
  checkJournalExplanations(req: JournalExplainCheckRequest): Promise<JournalExplainCheckResponse>;
  /** A fresh "Why?" after the check objected. */
  explainJournalWhy(req: JournalWhyRequest): Promise<IssueExplanation>;
}

/** [start, end) of the sentence holding a span (ends at 。！？!? or a line break, which it
 * includes), leading spaces skipped. */
export function sentenceRange(text: string, span: readonly [number, number]): [number, number] {
  const stops = /[。！？!?\n]/;
  let a = span[0];
  while (a > 0 && !stops.test(text[a - 1]!)) a--;
  while (a < span[0] && /\s/.test(text[a]!)) a++;
  let b = Math.max(span[1], a);
  while (b < text.length && !stops.test(text[b]!)) b++;
  if (b < text.length && text[b] !== '\n') b++;
  return [a, b];
}

/** The sentence around a span, or ±30 characters when the sentence is too long. */
export function contextAround(text: string, span: readonly [number, number]): string {
  const [a, b] = sentenceRange(text, span);
  const s = text.slice(a, b).trim();
  return s.length > 0 && s.length <= 300
    ? s
    : text.slice(Math.max(0, span[0] - 30), Math.min(text.length, span[1] + 30));
}

/** A structured "Why?" is usable when every part is filled and the Chinese is traditional. */
export function isUsableExplanation(e: IssueExplanation | undefined): e is IssueExplanation {
  if (!e) return false;
  if (![e.wrongEn, e.fixEn, e.exampleWrong, e.exampleRight].every((x) => x.trim().length > 0)) return false;
  if (e.exampleWrong.trim() === e.exampleRight.trim()) return false;
  // the wrong example may hold a mainland term on purpose; the right one may not
  return (
    checkTaiwanness(e.exampleWrong).simplifiedChars.length === 0 && checkTaiwanness(e.exampleRight).isClean
  );
}

export interface ExplainOptions {
  text: string;
  learnerLevel: Level;
  /** The learner's "What did you mean?" (entry or sentence). */
  intendedFor?: (issue: JournalIssue) => string | undefined;
}

/**
 * Part A.4: every explanation is checked by an independent call. One that fails (or is missing) is
 * written again once and checked again; if it still fails it is `unsure` ("We're not sure about
 * this one") and never practised. If the checker can't be reached the issue stays `pending` (the
 * caller retries later). Returns new issue objects; the input is not changed.
 */
export async function checkExplanations(
  llm: ExplainLLM,
  issues: readonly JournalIssue[],
  opts: ExplainOptions,
): Promise<JournalIssue[]> {
  const out = issues.map((i) => ({ ...i }));
  const todo = out
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => issue.explainStatus !== 'checked' && issue.explainStatus !== 'unsure');
  if (todo.length === 0) return out;

  const ask = (issue: JournalIssue) => ({
    sentence: contextAround(opts.text, issue.span),
    original: opts.text.slice(issue.span[0], issue.span[1]),
    correction: issue.correction,
    type: issue.type,
    ...(opts.intendedFor?.(issue) ? { intendedEn: opts.intendedFor(issue) } : {}),
  });

  // missing or unusable explanations are written first (no point checking nothing)
  const problems = new Map<number, string>();
  for (const { issue, index } of todo) {
    if (isUsableExplanation(issue.explain)) continue;
    const fresh = await regenerate(llm, issue, ask(issue), '', opts.learnerLevel);
    if (fresh === 'offline') return markPending(out, todo);
    if (fresh) out[index] = { ...out[index]!, explain: fresh };
    else problems.set(index, 'no usable explanation');
  }

  const round = async (indexes: number[]): Promise<Map<number, string> | 'offline'> => {
    const checkable = indexes.filter((i) => isUsableExplanation(out[i]!.explain));
    const failed = new Map<number, string>(
      indexes.filter((i) => !checkable.includes(i)).map((i) => [i, problems.get(i) ?? 'no usable explanation']),
    );
    if (checkable.length === 0) return failed;
    let res: JournalExplainCheckResponse;
    try {
      res = await llm.checkJournalExplanations({
        items: checkable.map((i) => ({ ...ask(out[i]!), explain: out[i]!.explain! })),
      });
    } catch {
      return 'offline';
    }
    checkable.forEach((issueIndex, k) => {
      const r = res.results.find((x) => x.index === k);
      // no verdict = not checked = not trusted
      if (!r || !r.ok) failed.set(issueIndex, r?.problem || 'the check did not confirm it');
    });
    return failed;
  };

  const first = await round(todo.map((t) => t.index));
  if (first === 'offline') return markPending(out, todo);
  for (const { index } of todo) if (!first.has(index)) out[index]!.explainStatus = 'checked';
  if (first.size === 0) return out;

  // one regeneration each, then one more check
  for (const [index, problem] of first) {
    const fresh = await regenerate(llm, out[index]!, ask(out[index]!), problem, opts.learnerLevel);
    if (fresh === 'offline') {
      out[index]!.explainStatus = 'pending';
      continue;
    }
    if (fresh) out[index] = { ...out[index]!, explain: fresh };
    else problems.set(index, problem);
  }
  const retry = [...first.keys()].filter((i) => out[i]!.explainStatus !== 'pending');
  const second = await round(retry);
  for (const index of retry) {
    if (second === 'offline') out[index]!.explainStatus = 'pending';
    else out[index]!.explainStatus = second.has(index) ? 'unsure' : 'checked';
  }
  return out;
}

function markPending(out: JournalIssue[], todo: { index: number }[]): JournalIssue[] {
  for (const { index } of todo) out[index]!.explainStatus = 'pending';
  return out;
}

async function regenerate(
  llm: ExplainLLM,
  issue: JournalIssue,
  base: Omit<JournalWhyRequest, 'problem' | 'learnerLevel'>,
  problem: string,
  learnerLevel: Level,
): Promise<IssueExplanation | null | 'offline'> {
  try {
    const fresh = await llm.explainJournalWhy({ ...base, problem, learnerLevel });
    void issue;
    return isUsableExplanation(fresh) ? fresh : null;
  } catch {
    return 'offline';
  }
}

/** Is this correction practised (error bank, evidence)? Not when its explanation failed the
 * check, the learner flagged it, or the learner's own sentence was upheld. */
export function issueIsPractised(issue: JournalIssue): boolean {
  return issue.explainStatus !== 'unsure';
}

/** Phase 31 Part E: how many times the learner has made a mistake of this kind (same pattern). */
export function sameMistakeCount(
  pattern: string | undefined,
  issues: readonly Pick<JournalIssue, 'pattern'>[],
): number {
  if (!pattern) return 0;
  const p = normalisePattern(pattern);
  return issues.filter((i) => i.pattern && normalisePattern(i.pattern) === p).length;
}

/** Phase 31 Part A.1: short rule notes a "Why?" links to when the correction's pattern is one of
 * these (a grammar point the lexicon has no item for yet). */
export interface RuleNote {
  id: string;
  title: string;
  explanationEn: string;
  examples: string[];
}

export const RULE_NOTES: readonly RuleNote[] = [
  {
    id: 'verb-object',
    title: 'Verb-object words (離合詞)',
    explanationEn:
      'Some verbs already contain their object: 念書 is 念 (read) + 書 (book), 吃飯 is 吃 (eat) + 飯 (rice). They can’t take a second object. To say what you study or eat, use the verb alone with the new object: 念中文, 吃牛肉麵.',
    examples: ['念書 → 念中文', '吃飯 → 吃牛肉麵', '睡覺 → 睡午覺', '唱歌 → 唱這首歌'],
  },
];

const RULE_ALIASES: Record<string, string> = {
  'verb-object': 'verb-object',
  'verb-object-word': 'verb-object',
  'separable-verb': 'verb-object',
  離合詞: 'verb-object',
};

export function ruleNoteFor(pattern: string | undefined): RuleNote | undefined {
  if (!pattern) return undefined;
  const id = RULE_ALIASES[normalisePattern(pattern)];
  return RULE_NOTES.find((r) => r.id === id);
}

// ---- Part B: alternatives keep the meaning --------------------------------------------------

export interface MeaningCheckLLM {
  verifyJournalSentence(req: JournalVerifyRequest): Promise<JournalVerifyResponse>;
}

/**
 * Each alternative the checker offered is put into the learner's sentence and sent to the
 * independent check with the intended meaning: "does this mean the same?". Returns each with
 * `sameMeaning`; an unreachable check or an unclean wording drops the alternative.
 */
export async function checkAlternativeMeanings(
  llm: MeaningCheckLLM,
  input: { sentence: string; original: string; intendedEn: string; alternatives: readonly Alternative[] },
): Promise<{ zh: string; meaningEn: string; sameMeaning: boolean }[]> {
  const out: { zh: string; meaningEn: string; sameMeaning: boolean }[] = [];
  for (const alt of input.alternatives.slice(0, 2)) {
    if (!checkTaiwanness(alt.zh).isClean) continue;
    const at = input.sentence.indexOf(input.original);
    const filled =
      at === -1 ? alt.zh : input.sentence.slice(0, at) + alt.zh + input.sentence.slice(at + input.original.length);
    try {
      const v = await llm.verifyJournalSentence({ zh: filled, en: input.intendedEn });
      out.push({ zh: alt.zh, meaningEn: alt.meaningEn, sameMeaning: v.ok && v.meaningMatches });
    } catch {
      // not checked: not shown
    }
  }
  return out;
}

/** The feedback line for a Spot the mistakes attempt, built from fields (Part B). */
export function alternativeLine(alt: { zh: string; meaningEn: string; sameMeaning: boolean }): string {
  return alt.sameMeaning
    ? `${alt.zh} also works`
    : `(${alt.zh} = ${alt.meaningEn || 'something else'}: a different meaning)`;
}

// ---- Part D: gap fills that fit the sentence ------------------------------------------------

export interface GapLLM extends MeaningCheckLLM {
  fillJournalGap(req: JournalGapRequest): Promise<JournalGapResponse>;
}

function glossParts(gloss: string): string[] {
  return gloss
    .toLowerCase()
    .split(/[;,/]/)
    .map((p) => p.replace(/^to\s+/, '').replace(/\(.*?\)/g, '').trim())
    .filter(Boolean);
}

/** Every lexicon word whose gloss has the English as a whole part (lowest level first). */
export function gapCandidates(en: string, lexicon: Lexicon, limit = 8): Word[] {
  const needle = en.toLowerCase().replace(/^to\s+/, '').trim();
  if (!needle) return [];
  const order = ['N1', 'N2', 'L1', 'L2', 'L3', 'L4', 'L5'];
  const rank = (w: Word) => (w.level ? order.indexOf(w.level) : order.length);
  return lexicon
    .allWords()
    .filter((w) => w.source !== 'custom' && glossParts(w.glossEn).includes(needle))
    .sort((a, b) => rank(a) - rank(b) || (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity))
    .slice(0, limit);
}

/** Pinyin from the lexicon (MOE readings) for a word or short phrase; '' when any part is unknown. */
export function lexiconPinyin(zh: string, lexicon: Lexicon): string {
  const tokens = segment(zh, lexicon);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'word') continue;
    const r = resolveReading(t, { prevToken: tokens[i - 1], nextToken: tokens[i + 1] }, lexicon);
    if (!r.pinyin || r.confidence === 'low') return '';
    parts.push(r.pinyin);
  }
  return parts.join(' ');
}

export interface ResolvedGapOption extends GapOption {
  /** The lexicon word to add to review, when the option is one word the lexicon has. */
  wordId?: string;
  /** true when the independent check approved the filled sentence. */
  checked: boolean;
}

/** The sentence holding a gap, with the gap written as ＿＿. */
export function gapSentence(text: string, gap: BracketGap): string {
  const ctx = contextAround(text, [gap.start, gap.end]);
  const raw = text.slice(gap.start, gap.end);
  return ctx.replace(raw, '＿＿');
}

/**
 * Part D: up to 3 options for one gap, in this sentence. The model picks among the lexicon
 * candidates plus its own idea and says how to use each; every option's filled sentence goes to
 * the independent check, and failures are dropped. Readings come from the lexicon where it has
 * them. If the model can't be reached, the lexicon candidates are listed as plain options (no
 * usage note, never checked). If the model answered but no option passed the check, nothing is
 * offered. Nothing is added to review here.
 */
export async function resolveGap(
  llm: GapLLM | undefined,
  lexicon: Lexicon,
  input: { text: string; gap: BracketGap; learnerLevel: Level; intendedEn?: string },
): Promise<ResolvedGapOption[]> {
  const candidates = gapCandidates(input.gap.en, lexicon);
  const sentence = gapSentence(input.text, input.gap);
  const fallback = (): ResolvedGapOption[] =>
    candidates.slice(0, 3).map((w) => ({
      zh: w.headword,
      pinyin: w.pinyin,
      meaningEn: w.glossEn,
      usageEn: '',
      corrected: sentence.replace('＿＿', w.headword),
      wordId: w.id,
      checked: false,
    }));
  if (!llm) return fallback();
  let res: JournalGapResponse;
  try {
    res = await llm.fillJournalGap({
      sentence,
      en: input.gap.en,
      candidates: candidates.map((w) => ({ zh: w.headword, glossEn: w.glossEn })),
      learnerLevel: input.learnerLevel,
      ...(input.intendedEn ? { intendedEn: input.intendedEn } : {}),
    });
  } catch {
    return fallback();
  }
  const out: ResolvedGapOption[] = [];
  const seen = new Set<string>();
  for (const opt of res.options.slice(0, 3)) {
    const zh = opt.zh.trim();
    if (!zh || seen.has(zh) || !checkTaiwanness(zh + opt.corrected).isClean) continue;
    if (/[＿_]/.test(opt.corrected) || extractBrackets(opt.corrected).length > 0) continue;
    seen.add(zh);
    let ok = false;
    try {
      const v = await llm.verifyJournalSentence({
        zh: opt.corrected,
        ...(input.intendedEn ? { en: input.intendedEn } : {}),
      });
      ok = v.ok && v.meaningMatches;
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const word = lexicon.lookup(zh)[0];
    out.push({
      ...opt,
      zh,
      pinyin: lexiconPinyin(zh, lexicon) || opt.pinyin,
      ...(word ? { wordId: word.id } : {}),
      checked: true,
    });
  }
  // the model answered but nothing passed the check: no guess is offered
  return out;
}
