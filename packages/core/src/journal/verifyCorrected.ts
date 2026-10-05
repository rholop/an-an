import { hashText } from '../hash.js';
import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import { splitReviewSentences } from './sentences.js';
import { resolveEdits, type ResolvedEdit } from './edits.js';
import type {
  JournalSentenceFixRequest,
  JournalSolveRequest,
  JournalSolveResponse,
  JournalVerifyRequest,
  JournalVerifyResponse,
  ModelSentenceReview,
  ProviderName,
} from './types.js';
import type { Level } from '../types.js';

/** The slice of the proxy the journal pipeline needs. apps/web's FetchTutorLLM
 * implements it; tests and the eval script pass their own. */
export interface JournalLLM {
  /** Retry after the checker objected: one new corrected version. */
  fixJournalSentence(
    req: JournalSentenceFixRequest,
  ): Promise<{ review: ModelSentenceReview; servedBy?: ProviderName }>;
  /** The independent checker (never given the original sentence). */
  verifyJournalSentence(req: JournalVerifyRequest): Promise<JournalVerifyResponse>;
  /** The solver test for a cloze. */
  solveJournalCloze(req: JournalSolveRequest): Promise<JournalSolveResponse>;
}

export interface VerifiedSentence {
  /** Stable id: hash of the original and the protected terms. */
  id: string;
  original: string;
  /** Where the sentence sits in the entry text. */
  start: number;
  end: number;
  corrected: string;
  en: string;
  natural?: string;
  /** Smallest token-level edits (empty when the sentence was already correct). */
  edits: ResolvedEdit[];
  modelEditsUsable: boolean;
  status: 'verified' | 'rejected';
  /** Why a rejected sentence was rejected. */
  reason?: string;
  servedBy?: ProviderName;
  checkedAt: Date;
}

/** Cache of verdicts per sentence, so a sentence is never checked twice. */
export interface SentenceCache {
  get(key: string): Promise<VerifiedSentence | undefined>;
  set(key: string, value: VerifiedSentence): Promise<void>;
}

export function sentenceKey(original: string, protectedTerms: readonly string[]): string {
  return `s2:${hashText(original)}:${hashText([...protectedTerms].sort().join('|'))}`;
}

const LATIN_OR_BRACKET = /[A-Za-z[\]［］()（）<>{}]/;

/** Part B step 1: rules, no model. Returns the problems found (empty = clean). */
export function checkCorrectedRules(
  corrected: string,
  opts: { lexicon: Lexicon; original?: string; protectedTerms?: readonly string[] },
): string[] {
  const problems: string[] = [];
  const text = corrected.trim();
  if (!text) return ['empty sentence'];
  if (!/[一-鿿]/.test(text)) problems.push('no Chinese characters');
  const tw = checkTaiwanness(text);
  if (tw.simplifiedChars.length > 0) problems.push('contains simplified characters');
  if (tw.mainlandTerms.length > 0)
    problems.push(`mainland wording: ${tw.mainlandTerms.map((t) => t.matched).join('、')}`);
  if (LATIN_OR_BRACKET.test(text)) problems.push('contains Latin text or brackets');
  if (/[\u{10000}-\u{10FFFF}]/u.test(text)) problems.push('contains an emoji or rare character');
  if (splitReviewSentences(text).length > 1) problems.push('is more than one sentence');

  const protectedTerms = opts.protectedTerms ?? [];
  const unknown: string[] = [];
  for (const t of segment(text, opts.lexicon)) {
    if (t.kind !== 'unknown') continue;
    const insideProtected = protectedTerms.some((p) => {
      for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1))
        if (t.start >= i && t.end <= i + p.length) return true;
      return false;
    });
    if (!insideProtected) unknown.push(t.text);
  }
  if (unknown.length > 0) problems.push(`does not segment cleanly (${unknown.join('')})`);

  if (opts.original !== undefined) {
    // A name the learner wrote must survive. (Not a count: 印 can be both the
    // surname and a mistaken word, and fixing the mistaken one is right.)
    for (const p of protectedTerms)
      if (opts.original.includes(p) && !text.includes(p))
        problems.push(`changed the protected term ${p}`);
  }
  return problems;
}

export interface VerifyDeps {
  lexicon: Lexicon;
  llm: JournalLLM;
  protectedTerms: readonly string[];
  learnerLevel: Level;
}

/** Part B steps 1-3 on a piece of Chinese: rules, then the independent
 * checker (other provider when `avoidProvider` is given), which also confirms
 * the meaning when `en` is given. Network errors propagate. */
export async function verifySentenceText(
  deps: {
    lexicon: Lexicon;
    llm: Pick<JournalLLM, 'verifyJournalSentence'>;
    protectedTerms: readonly string[];
  },
  zh: string,
  opts: { en?: string; original?: string; avoidProvider?: ProviderName } = {},
): Promise<{ ok: boolean; problem: string }> {
  const rules = checkCorrectedRules(zh, {
    lexicon: deps.lexicon,
    original: opts.original,
    protectedTerms: deps.protectedTerms,
  });
  if (rules.length > 0) return { ok: false, problem: rules.join('; ') };
  const res = await deps.llm.verifyJournalSentence({
    zh,
    ...(opts.en ? { en: opts.en } : {}),
    ...(opts.avoidProvider ? { avoidProvider: opts.avoidProvider } : {}),
  });
  if (!res.ok) return { ok: false, problem: res.problem || 'the checker objected' };
  if (opts.en && !res.meaningMatches)
    return { ok: false, problem: 'the checker says the Chinese does not mean the English' };
  return { ok: true, problem: '' };
}

export interface VerifyInput {
  original: string;
  start: number;
  end: number;
  review: ModelSentenceReview;
  servedBy?: ProviderName;
  now: Date;
}

/**
 * Part B. Runs once per sentence and is cached by the caller. Rules ->
 * independent check -> meaning check. If either objects, the reviewing model
 * gets one chance to fix it; a second failure rejects the sentence (no items).
 * A rejected sentence is still returned (and cacheable) so it isn't retried
 * forever.
 */
export async function verifyCorrected(
  deps: VerifyDeps,
  input: VerifyInput,
): Promise<VerifiedSentence> {
  const { original, start, end, now } = input;
  const base = {
    id: sentenceKey(original, deps.protectedTerms),
    original,
    start,
    end,
    checkedAt: now,
  };
  const reject = (
    review: ModelSentenceReview,
    reason: string,
    servedBy?: ProviderName,
  ): VerifiedSentence => ({
    ...base,
    corrected: review.corrected,
    en: review.en,
    edits: [],
    modelEditsUsable: false,
    status: 'rejected',
    reason,
    servedBy,
  });

  let review = input.review;
  let servedBy = input.servedBy;
  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      const fix = await deps.llm.fixJournalSentence({
        original,
        rejected: review.corrected,
        problem: lastProblem,
        learnerLevel: deps.learnerLevel,
        protectedTerms: [...deps.protectedTerms],
      });
      review = fix.review;
      servedBy = fix.servedBy ?? servedBy;
    }
    const corrected = review.corrected.trim();
    const resolved = resolveEdits(original, corrected, review.edits, deps.lexicon);
    if (!resolved) {
      lastProblem = 'the changes could not be reconciled with the original';
      continue;
    }
    const check = await verifySentenceText(deps, corrected, {
      en: review.en,
      original,
      avoidProvider: servedBy,
    });
    if (!check.ok) {
      lastProblem = check.problem;
      continue;
    }
    return {
      ...base,
      corrected,
      en: review.en,
      natural: review.natural,
      edits: resolved.edits,
      modelEditsUsable: resolved.modelEditsUsable,
      status: 'verified',
      servedBy,
    };
  }
  return reject(review, lastProblem, servedBy);
}
