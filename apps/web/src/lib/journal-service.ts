import {
  buildCustomWord,
  buildErrorItems,
  checkTaiwanness,
  compareSelfFix,
  errorsPer100Chars,
  extractBrackets,
  findWordsUsed,
  lookupBracketInLexicon,
  MAX_JOURNAL_ISSUES,
  planJournalEvidence,
  summarizeLevels,
  topErrorPatterns,
  validateJournalReview,
  type Evidence,
  type JournalReview,
  type Level,
  type Lexicon,
  type SelfFixRecord,
  type TutorLLM,
  type Word,
} from '@anan/core';
import type { AnanDB, JournalEntryRow, JournalReviewRow, ResolvedBracket } from '../db/schema.js';
import type { LearnerService } from './learner-service.js';

export interface JournalServiceConfig {
  maxIssues: number;
  /** How many of the learner's top recent error patterns to send. */
  recentPatternLimit: number;
  /** "Recent" window for those patterns. */
  recentPatternDays: number;
}

export const DEFAULT_JOURNAL_CONFIG: JournalServiceConfig = {
  maxIssues: MAX_JOURNAL_ISSUES,
  recentPatternLimit: 5,
  recentPatternDays: 60,
};

export interface SubmitEntryInput {
  text: string;
  learnerLevel: Level;
  promptId?: string;
  promptWordIds?: string[];
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

const DAY_MS = 86_400_000;

/**
 * Phase 5 orchestration: submit -> (self-correct) -> reveal -> finish. Pure
 * logic lives in core (journal/*); this class sequences LLM calls, validation,
 * Dexie writes and learner evidence. `now` is always a parameter.
 */
export class JournalService {
  constructor(
    private readonly db: AnanDB,
    private readonly lexicon: Lexicon,
    private readonly learnerService: LearnerService,
    private readonly tutorLLM: TutorLLM,
    private readonly config: JournalServiceConfig = DEFAULT_JOURNAL_CONFIG,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  getEntry(id: string): Promise<JournalEntryRow | undefined> {
    return this.db.journalEntries.get(id);
  }

  getReview(entryId: string): Promise<JournalReviewRow | undefined> {
    return this.db.journalReviews.get(entryId);
  }

  /**
   * Sends the entry for review, validates what comes back, resolves
   * `[English gaps]` (lexicon first, then the model), and stores everything.
   * Nothing is written if the LLM call or its validation fails, so the
   * learner can simply resubmit the text still in their editor.
   */
  async submit(
    input: SubmitEntryInput,
    now: Date = new Date(),
  ): Promise<{ entry: JournalEntryRow; review: JournalReviewRow }> {
    const text = input.text.trim();
    if (!text) throw new JournalError('Write something first.');

    const promptWordIds = input.promptWordIds ?? [];
    const promptWords = promptWordIds
      .map((id) => this.lexicon.byId(id))
      .filter((w): w is Word => Boolean(w));
    const gaps = extractBrackets(text);

    const recentErrors = await this.db.errorItems
      .filter(
        (e) => e.createdAt.getTime() >= now.getTime() - this.config.recentPatternDays * DAY_MS,
      )
      .toArray();
    const recurringPatterns = topErrorPatterns(recentErrors, this.config.recentPatternLimit);

    const raw = await this.tutorLLM.reviewJournal({
      text,
      learnerLevel: input.learnerLevel,
      promptWords: promptWords.map((w) => w.headword),
      recurringPatterns,
      maxIssues: this.config.maxIssues,
    });
    const { review, rejected } = validateJournalReview(raw, {
      lexicon: this.lexicon,
      text,
      maxIssues: this.config.maxIssues,
      recurringPatterns,
      bracketRanges: gaps.map((g): [number, number] => [g.start, g.end]),
    });

    const brackets = await this.resolveBrackets(
      gaps.map((g) => g.en),
      review,
      now,
    );
    const levels = summarizeLevels(text, this.lexicon);

    const entry: JournalEntryRow = {
      id: this.newId(),
      text,
      promptId: input.promptId,
      promptWordIds,
      createdAt: now,
      status: review.issues.length > 0 ? 'self_correcting' : 'revealed',
    };
    const reviewRow: JournalReviewRow = {
      entryId: entry.id,
      learnerLevel: input.learnerLevel,
      issues: review.issues,
      naturalRewrite: review.natural_rewrite,
      brackets,
      usedWell: review.used_well,
      rejectedCount: rejected.length,
      selfFix: {},
      flagged: [],
      explainMore: {},
      levelHeadline: levels.headline,
      wordsUsed: levels.wordsUsed,
      errorsPer100Chars: errorsPer100Chars(review.issues.length, text),
      createdAt: now,
    };
    await this.db.transaction('rw', this.db.journalEntries, this.db.journalReviews, async () => {
      await this.db.journalEntries.add(entry);
      await this.db.journalReviews.add(reviewRow);
    });
    return { entry, review: reviewRow };
  }

  /**
   * Phase 5 §2: each bracket gets a Taiwan-appropriate translation — the
   * lexicon first, else the (already validated) model translation — and the
   * word becomes a high-priority production item that the next cloze session
   * serves first. A word with no lexicon entry becomes a `custom` word.
   */
  private async resolveBrackets(
    gapEnglish: string[],
    review: JournalReview,
    now: Date,
  ): Promise<ResolvedBracket[]> {
    const resolved: ResolvedBracket[] = [];
    const seen = new Set<string>();
    for (const en of gapEnglish) {
      if (seen.has(en.toLowerCase())) continue;
      seen.add(en.toLowerCase());

      const fromLexicon = lookupBracketInLexicon(en, this.lexicon);
      const fromLlm = review.brackets.find((b) => b.en.trim().toLowerCase() === en.toLowerCase());

      let word: Word | undefined;
      let source: ResolvedBracket['source'] = 'unresolved';
      let zh = '';
      if (fromLexicon) {
        word = fromLexicon;
        zh = fromLexicon.headword;
        source = 'lexicon';
      } else if (fromLlm) {
        zh = fromLlm.zh;
        source = 'llm';
        word =
          (fromLlm.wordId ? this.lexicon.byId(fromLlm.wordId) : undefined) ??
          this.lexicon.lookup(fromLlm.zh)[0];
        if (!word && checkTaiwanness(zh).isClean) {
          word = { ...buildCustomWord(zh, '', en), tags: ['journal-gap'] };
          await this.db.customWords.put(word);
        }
      }
      if (word) await this.addPriorityItem(word, now);
      resolved.push({ en, zh, wordId: word?.id, source });
    }
    return resolved;
  }

  private async addPriorityItem(word: Word, now: Date): Promise<void> {
    const item = { kind: 'word', id: word.id } as const;
    // chat_lookup_gloss on the *production* skill: introduces the card due
    // now (or, if the learner already had it in review, an Again — they
    // couldn't produce it). It's the closest existing evidence kind; the
    // priority flag below is what actually moves it to the front.
    const card = await this.learnerService.record(
      {
        item,
        skill: 'production',
        kind: 'chat_lookup_gloss',
        at: now,
        context: { source: 'journal' },
      },
      now,
    );
    if (card)
      await this.learnerService.putCard({ ...card, flags: { ...card.flags, priority: true } });
  }

  /**
   * Phase 5 §4.2: re-check just one highlighted span. Local compare against
   * the suggested correction first; only a differing edit costs an LLM call
   * (cached per attempt on the review row, and again by the proxy).
   */
  async recheckSpan(entryId: string, issueIndex: number, attempt: string): Promise<SelfFixRecord> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    const issue = review?.issues[issueIndex];
    if (!entry || !review || !issue) throw new JournalError('Unknown issue.');
    if (entry.status === 'finished') throw new JournalError('This entry is finished.');

    const original = entry.text.slice(issue.span[0], issue.span[1]);
    const trimmed = attempt.trim();
    const previous = review.selfFix[issueIndex];
    if (previous && previous.attempt === trimmed) return previous;

    let record: SelfFixRecord;
    const local = compareSelfFix(issue, original, trimmed);
    if (local === 'fixed') {
      record = { attempt: trimmed, fixed: true };
    } else if (local === 'unchanged') {
      record = { attempt: trimmed, fixed: false };
    } else if (!checkTaiwanness(trimmed).isClean) {
      record = {
        attempt: trimmed,
        fixed: false,
        note: 'Please use traditional characters and Taiwan wording.',
      };
    } else {
      try {
        const res = await this.tutorLLM.checkJournalFix({
          sentence: entry.text.slice(
            Math.max(0, issue.span[0] - 30),
            Math.min(entry.text.length, issue.span[1] + 30),
          ),
          original,
          attempt: trimmed,
          correction: issue.correction,
        });
        record = {
          attempt: trimmed,
          fixed: res.acceptable,
          alternative: res.acceptable,
          note: res.noteEn,
        };
      } catch {
        record = {
          attempt: trimmed,
          fixed: false,
          note: "Couldn't check that alternative just now.",
        };
      }
    }
    await this.db.journalReviews.update(entryId, {
      selfFix: { ...review.selfFix, [issueIndex]: record },
    });
    return record;
  }

  /** Reveal corrections, explanations and the natural rewrite (§4.3). */
  async reveal(entryId: string): Promise<void> {
    const entry = await this.getEntry(entryId);
    if (entry && entry.status === 'self_correcting')
      await this.db.journalEntries.update(entryId, { status: 'revealed' });
  }

  /** Toggle a "flag this correction" mark. Flagged corrections never reach
   * the error bank or evidence; the count is a dev metric (journalFlagCount). */
  async toggleFlag(entryId: string, issueIndex: number): Promise<boolean> {
    const review = await this.getReview(entryId);
    const entry = await this.getEntry(entryId);
    if (!review || !entry || !review.issues[issueIndex]) throw new JournalError('Unknown issue.');
    if (entry.status === 'finished') throw new JournalError('This entry is finished.');
    const flagged = review.flagged.includes(issueIndex)
      ? review.flagged.filter((i) => i !== issueIndex)
      : [...review.flagged, issueIndex];
    await this.db.journalReviews.update(entryId, { flagged });
    return flagged.includes(issueIndex);
  }

  /** "Explain more" follow-up call; the result is stored so reopening the
   * entry doesn't re-ask. */
  async explainMore(entryId: string, issueIndex: number) {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    const issue = review?.issues[issueIndex];
    if (!entry || !review || !issue) throw new JournalError('Unknown issue.');
    const stored = review.explainMore[issueIndex];
    if (stored) return stored;

    const res = await this.tutorLLM.explainJournalIssue({
      sentence: entry.text.slice(
        Math.max(0, issue.span[0] - 30),
        Math.min(entry.text.length, issue.span[1] + 30),
      ),
      original: entry.text.slice(issue.span[0], issue.span[1]),
      correction: issue.correction,
      explanationEn: issue.explanationEn,
      learnerLevel: review.learnerLevel,
    });
    // Same trust rules as any model output: drop examples that aren't clean
    // Taiwan traditional Chinese.
    const examples = res.examples.filter((e) => checkTaiwanness(e.zh).isClean);
    const value = { explanationEn: res.explanationEn, examples };
    await this.db.journalReviews.update(entryId, {
      explainMore: { ...review.explainMore, [issueIndex]: value },
    });
    return value;
  }

  /**
   * Closes the entry: writes the error bank (non-flagged issues only) and
   * the learner evidence (§6). Idempotent.
   */
  async finish(
    entryId: string,
    now: Date = new Date(),
  ): Promise<{ errorItemCount: number; evidence: Evidence[] }> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    if (!entry || !review) throw new JournalError('Unknown entry.');
    if (entry.status === 'finished') return { errorItemCount: 0, evidence: [] };

    const kept = review.issues
      .map((issue, index) => ({ issue, index }))
      .filter(({ index }) => !review.flagged.includes(index));

    const errorItems = buildErrorItems(entryId, entry.text, kept, now);

    const promptWords = entry.promptWordIds
      .map((id) => this.lexicon.byId(id))
      .filter((w): w is Word => Boolean(w));
    const wrongSpans = kept.map(({ issue }) => issue.span);
    const promptWordsUsed = [...findWordsUsed(entry.text, promptWords, this.lexicon, wrongSpans)];
    const flaggedSpans = review.flagged.map((i) => review.issues[i]!.span);

    const evidence = planJournalEvidence({
      entryId,
      now,
      usedWell: review.usedWell.filter(
        (u) => !flaggedSpans.some(([a, b]) => a < u.span[1] && u.span[0] < b),
      ),
      promptWordsUsed,
      issues: kept.map(({ issue, index }) => ({
        issue,
        selfFixed: review.selfFix[index]?.fixed === true,
      })),
    });

    await this.db.transaction(
      'rw',
      this.db.errorItems,
      this.db.journalEntries,
      this.db.journalReviews,
      async () => {
        if (errorItems.length > 0) await this.db.errorItems.bulkPut(errorItems);
        await this.db.journalEntries.update(entryId, { status: 'finished', finishedAt: now });
        await this.db.journalReviews.update(entryId, {
          errorsPer100Chars: errorsPer100Chars(kept.length, entry.text),
        });
      },
    );
    if (evidence.length > 0) await this.learnerService.recordBulk(evidence, now);
    return { errorItemCount: errorItems.length, evidence };
  }
}

/** Dev metric from phase doc §5: how many corrections learners have flagged
 * as wrong, against how many were shown. */
export async function journalFlagStats(db: AnanDB): Promise<{ flagged: number; shown: number }> {
  let flagged = 0;
  let shown = 0;
  await db.journalReviews.each((r) => {
    flagged += r.flagged.length;
    shown += r.issues.length;
  });
  return { flagged, shown };
}
