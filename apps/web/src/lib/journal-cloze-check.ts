import {
  checkErrorItem,
  checkJournalSentence,
  hashText,
  splitReviewSentences,
  type ClozeCheckLLM,
  type JournalSentenceVerdict,
  type Lexicon,
} from '@anan/core';
import type { AnanDB } from '../db/schema.js';

// Phase 16 Part B, run against stored data: the check for every journal item
// and journal sentence, once, and again for anything still pending.

export const SENTENCE_CHECK_PREFIX = 'clozeCheck:';
export const sentenceCheckKey = (zh: string) => `${SENTENCE_CHECK_PREFIX}${hashText(zh)}`;

export async function loadSentenceVerdicts(db: AnanDB): Promise<Map<string, JournalSentenceVerdict>> {
  const rows = await db.settings.where('key').startsWith(SENTENCE_CHECK_PREFIX).toArray();
  return new Map(rows.map((r) => [r.key, r.value as JournalSentenceVerdict]));
}

/** Latin names the learner may use (their protected terms that contain letters). */
export async function allowedLatinNames(db: AnanDB): Promise<string[]> {
  const row = await db.settings.get('protectedTerms');
  const terms = Array.isArray(row?.value) ? (row!.value as unknown[]) : [];
  return terms.filter((t): t is string => typeof t === 'string' && /[A-Za-z]/.test(t));
}

export interface CheckRunSummary {
  items: { active: number; blocked: number; pending: number };
  sentences: { ok: number; blocked: number; pending: number };
}

/**
 * Checks every `pending_check` journal item and every finished-entry sentence
 * that has no verdict yet. A model that can't be reached leaves things
 * `pending` (hidden) for the next run; nothing is ever shown unchecked.
 * `sentenceBlocklist` supplies the sentences an entry's review raised issues
 * about, which are never used as a cloze source as written.
 */
export async function runJournalClozeChecks(
  db: AnanDB,
  lexicon: Lexicon,
  llm: ClozeCheckLLM | undefined,
  now: Date = new Date(),
): Promise<CheckRunSummary> {
  const allowedNames = await allowedLatinNames(db);
  const summary: CheckRunSummary = {
    items: { active: 0, blocked: 0, pending: 0 },
    sentences: { ok: 0, blocked: 0, pending: 0 },
  };

  const items = await db.errorItems.filter((i) => !i.status || i.status === 'pending_check').toArray();
  for (const item of items) {
    const next = await checkErrorItem({ ...item, status: item.status ?? 'pending_check' }, {
      lexicon,
      llm,
      allowedNames,
    });
    if (next.status !== item.status || next.blockedReason !== item.blockedReason)
      await db.errorItems.put(next);
    if (next.status === 'active') summary.items.active++;
    else if (next.status === 'blocked') summary.items.blocked++;
    else summary.items.pending++;
  }

  const [entries, reviews, verdicts] = await Promise.all([
    db.journalEntries.filter((e) => e.status === 'finished').toArray(),
    db.journalReviews.toArray(),
    loadSentenceVerdicts(db),
  ]);
  const issueSpans = new Map(reviews.map((r) => [r.entryId, r.issues.map((i) => i.span)]));
  for (const entry of entries) {
    const spans = issueSpans.get(entry.id);
    if (!spans) continue; // no review: nothing is offered
    for (const [s, e] of splitReviewSentences(entry.text)) {
      if (spans.some(([a, b]) => a < e && s < b)) continue;
      const zh = entry.text.slice(s, e);
      if ([...zh].length < 4) continue;
      const key = sentenceCheckKey(zh);
      if (verdicts.has(key)) {
        const v = verdicts.get(key)!;
        if (v.ok) summary.sentences.ok++;
        else summary.sentences.blocked++;
        continue;
      }
      const verdict = await checkJournalSentence(zh, { lexicon, llm, allowedNames });
      if (verdict.status === 'pending') {
        summary.sentences.pending++;
        continue;
      }
      const value: JournalSentenceVerdict = {
        zh,
        ok: verdict.status === 'ok',
        reason: verdict.status === 'blocked' ? verdict.reason : undefined,
        entryId: entry.id,
        at: now.toISOString(),
      };
      await db.settings.put({ key, value });
      if (verdict.status === 'ok') summary.sentences.ok++;
      else summary.sentences.blocked++;
    }
  }
  return summary;
}
