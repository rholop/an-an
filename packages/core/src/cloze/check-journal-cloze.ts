import { z } from 'zod';
import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import { checkTaiwanness } from '../taiwanness.js';
import { splitSentences } from '../journal/sentences.js';

export const ClozeCheckRequestSchema = z.object({ sentence: z.string().min(1).max(300) });
export type ClozeCheckRequest = z.infer<typeof ClozeCheckRequestSchema>;

/** POST /v1/cloze-check response (Phase 16 Part B). */
export const ClozeCheckResponseSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type ClozeCheckResult = z.infer<typeof ClozeCheckResponseSchema>;

/** The one model call the check makes: is this a natural, correct sentence? */
export interface ClozeCheckLLM {
  checkCloze(req: ClozeCheckRequest): Promise<ClozeCheckResult>;
}

export interface JournalClozeInput {
  /** The full corrected sentence. */
  sentence: string;
  blankStart: number;
  blankEnd: number;
  /** The text the blank hides. */
  answer: string;
}

export interface ClozeCheckOptions {
  lexicon: Lexicon;
  /** Latin names the learner may use (e.g. their own name). */
  allowedNames?: readonly string[];
}

const MARKUP = /[<>{}`*_#|\\]|\[|\]|［|］/;
const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;
const ENDS = /[。！？!?」』”’）)…]$/;

/**
 * Phase 16 Part B, the rules half (no model): returns every reason the cloze
 * must not be shown. An empty list means it passes the rules.
 *  - one whole sentence, traditional characters, Taiwan wording
 *  - no brackets, Latin letters (bar allowed names) or leftover markup
 *  - emoji and characters outside the BMP are refused (they break offsets)
 *  - clean tokens; the blank lines up with whole tokens
 *  - the answer is non-empty, not the whole sentence, and
 *    before + answer + after rebuilds the stored sentence exactly
 */
export function checkJournalClozeRules(
  input: JournalClozeInput,
  opts: ClozeCheckOptions,
): string[] {
  const { sentence, blankStart, blankEnd, answer } = input;
  const reasons: string[] = [];
  const text = sentence;
  if (!text.trim()) return ['empty sentence'];
  if (text !== text.trim()) reasons.push('sentence has stray whitespace');

  const spans = splitSentences(text);
  if (spans.length !== 1) reasons.push('not a single sentence');
  else if (!ENDS.test(text.trim()) && [...text].length < 4) reasons.push('sentence is a fragment');
  if (/^[，、。！？,.!?；;：:」』”’）)]/.test(text)) reasons.push('starts mid-sentence');
  if (/\n/.test(text)) reasons.push('contains a line break');

  if (NON_BMP.test(text)) reasons.push('contains an emoji or rare character');
  if (MARKUP.test(text)) reasons.push('contains brackets or leftover markup');
  const tw = checkTaiwanness(text);
  if (tw.simplifiedChars.length > 0) reasons.push('contains simplified characters');
  if (tw.mainlandTerms.length > 0) reasons.push('uses mainland wording');
  if (!/[一-鿿]/.test(text)) reasons.push('no Chinese characters');

  // Latin letters are only allowed inside an allowed name.
  let latin = text;
  for (const n of opts.allowedNames ?? []) latin = latin.split(n).join('');
  if (/[A-Za-z]/.test(latin)) reasons.push('contains Latin letters');

  const inRange =
    Number.isInteger(blankStart) &&
    Number.isInteger(blankEnd) &&
    blankStart >= 0 &&
    blankEnd > blankStart &&
    blankEnd <= text.length;
  if (!inRange) {
    reasons.push('blank is out of range');
    return reasons;
  }
  if (!answer) reasons.push('answer is empty');
  if (answer === text) reasons.push('the answer is the whole sentence');
  if (text.slice(blankStart, blankEnd) !== answer)
    reasons.push('before + answer + after does not rebuild the sentence');
  if (text.slice(0, blankStart) + answer + text.slice(blankEnd) !== text)
    reasons.push('before + answer + after does not rebuild the sentence');

  const tokens = segment(text, opts.lexicon);
  const unknown = tokens.filter(
    (t) => t.kind === 'unknown' && !(opts.allowedNames ?? []).some((n) => text.includes(n)),
  );
  if (unknown.length > 0)
    reasons.push(`does not segment cleanly (${unknown.map((t) => t.text).join('')})`);
  const startsOk = blankStart === 0 || tokens.some((t) => t.end === blankStart);
  const endsOk = blankEnd === text.length || tokens.some((t) => t.end === blankEnd);
  if (!startsOk || !endsOk) reasons.push('the blank does not line up with whole words');
  return [...new Set(reasons)];
}

export type JournalClozeVerdict =
  | { status: 'ok' }
  | { status: 'blocked'; reason: string }
  /** The model could not be reached: keep the item pending and retry later. */
  | { status: 'pending'; reason: string };

/**
 * Part B in full: rules first (a failure never costs a model call), then one
 * naturalness check of the corrected sentence. A thrown model error means
 * `pending`, never `ok`: an unchecked item is not shown.
 */
export async function checkJournalCloze(
  input: JournalClozeInput,
  opts: ClozeCheckOptions & { llm?: ClozeCheckLLM },
): Promise<JournalClozeVerdict> {
  const reasons = checkJournalClozeRules(input, opts);
  if (reasons.length > 0) return { status: 'blocked', reason: reasons.join('; ') };
  if (!opts.llm) return { status: 'pending', reason: 'waiting for the naturalness check' };
  try {
    const res = await opts.llm.checkCloze({ sentence: input.sentence });
    return res.ok
      ? { status: 'ok' }
      : { status: 'blocked', reason: res.reason?.trim() || 'the checker said the sentence is not natural' };
  } catch (err) {
    return { status: 'pending', reason: `check unavailable: ${String(err)}` };
  }
}

/** Rules for a journal sentence that will be a plain cloze source (no fixed
 * blank yet): the same checks with the blank on its first word. */
export function checkJournalSentenceRules(sentence: string, opts: ClozeCheckOptions): string[] {
  const first = segment(sentence, opts.lexicon).find((t) => t.kind === 'word');
  if (!first) return ['no words in the sentence'];
  return checkJournalClozeRules(
    { sentence, blankStart: first.start, blankEnd: first.end, answer: first.text },
    opts,
  );
}

/** The cached verdict stored per journal sentence (key `clozeCheck:<hash>`). */
export interface JournalSentenceVerdict {
  zh: string;
  ok: boolean;
  reason?: string;
  entryId?: string;
  at: string;
}

export async function checkJournalSentence(
  sentence: string,
  opts: ClozeCheckOptions & { llm?: ClozeCheckLLM },
): Promise<JournalClozeVerdict> {
  const reasons = checkJournalSentenceRules(sentence, opts);
  if (reasons.length > 0) return { status: 'blocked', reason: reasons.join('; ') };
  if (!opts.llm) return { status: 'pending', reason: 'waiting for the naturalness check' };
  try {
    const res = await opts.llm.checkCloze({ sentence });
    return res.ok
      ? { status: 'ok' }
      : { status: 'blocked', reason: res.reason?.trim() || 'the checker said the sentence is not natural' };
  } catch (err) {
    return { status: 'pending', reason: `check unavailable: ${String(err)}` };
  }
}
