import type { JournalIssue } from './types.js';

export type SelfFixResult =
  /** Matches the suggested correction. */
  | 'fixed'
  /** Left unchanged (or cleared) — counts as not self-fixed. */
  | 'unchanged'
  /** Changed to something else; needs the cached LLM alternatives check. */
  | 'needs_check';

const STRIP = /[\s，。、！？,.!?；;：:]/g;
const norm = (s: string) => s.normalize('NFKC').replace(STRIP, '');

/** Phase 5 §4.2, the local half: compare the learner's edit of a highlighted
 * span against the suggested correction. */
export function compareSelfFix(
  issue: Pick<JournalIssue, 'correction'>,
  original: string,
  attempt: string,
): SelfFixResult {
  const a = norm(attempt);
  if (!a || a === norm(original)) return 'unchanged';
  if (a === norm(issue.correction)) return 'fixed';
  return 'needs_check';
}

export interface SelfFixRecord {
  attempt: string;
  /** true if the learner's own fix was accepted (locally or by the LLM). */
  fixed: boolean;
  /** An accepted alternative that differed from the suggested correction. */
  alternative?: boolean;
  note?: string;
  /** Phase 31 Part B: other wordings, each with its meaning and whether it keeps the learner's
   * meaning (checked by code with the independent check). One that changes it is shown with its
   * meaning, never as "also a good option". */
  alternatives?: { zh: string; meaningEn: string; sameMeaning: boolean }[];
}
