import {
  attachModelReviews,
  blockErrorItem,
  buildCustomWord,
  buildEntryItems,
  carryOverSchedule,
  isLegacyErrorItem,
  prepareSentences,
  verifyEntrySentences,
  type ErrorItem,
  type SentenceCache,
  type VerifiedSentence,
  checkAlternativeMeanings,
  checkExplanations,
  checkTaiwanness,
  compareSelfFix,
  contextAround,
  sentenceRange,
  gapCandidates,
  resolveGap,
  JOURNAL_ASK_MAX_TURNS,
  type ExplainLLM,
  type GapLLM,
  type JournalAskTurn,
  type JournalIssue,
  type SkillCard,
  errorsPer100Chars,
  extractBrackets,
  findWordsUsed,
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
import { saveProgressNow } from './save-progress.js';
import type { AnanDB, JournalDispute, JournalEntryRow, JournalReviewRow, ResolvedBracket } from '../db/schema.js';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import type { LearnerService } from './learner-service.js';
import { getProtectedTerms } from './journal-protected.js';

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
  /** Phase 31 Part C.2: "What did you mean?" (optional). */
  intendedEn?: string;
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
    /** Phase 6: called once an entry is finished, with the issue indexes the
     * learner fixed themselves. */
    private readonly onFinished?: (
      entryId: string,
      selfFixedIssueIndexes: number[],
      at: Date,
    ) => Promise<void>,
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

    // Phase 17 Part A: split by code, so `original` always matches the entry,
    // and send the learner's own names as protected terms.
    const prepared = prepareSentences(text);
    const protectedTerms = await getProtectedTerms(this.db);
    const raw = await this.tutorLLM.reviewJournal({
      text,
      learnerLevel: input.learnerLevel,
      promptWords: promptWords.map((w) => w.headword),
      recurringPatterns,
      maxIssues: this.config.maxIssues,
      sentences: prepared.map((p) => p.original),
      protectedTerms,
      ...(input.intendedEn?.trim() ? { intendedEn: input.intendedEn.trim() } : {}),
    });
    const { review, rejected } = validateJournalReview(raw, {
      lexicon: this.lexicon,
      text,
      maxIssues: this.config.maxIssues,
      recurringPatterns,
      bracketRanges: gaps.map((g): [number, number] => [g.start, g.end]),
    });

    // Phase 31 Part A.4: every explanation is checked before it is shown.
    const intendedEn = input.intendedEn?.trim() || undefined;
    const issues = await this.checkIssues(review.issues, text, input.learnerLevel, () => intendedEn);
    const brackets = await this.resolveBrackets(text, gaps, review, input.learnerLevel, intendedEn);
    const levels = summarizeLevels(text, this.lexicon, input.learnerLevel);

    const entry: JournalEntryRow = {
      id: this.newId(),
      text,
      promptId: input.promptId,
      promptWordIds,
      createdAt: now,
      status: issues.length > 0 ? 'self_correcting' : 'revealed',
      ...(intendedEn ? { intendedEn } : {}),
    };
    const reviewRow: JournalReviewRow = {
      entryId: entry.id,
      learnerLevel: input.learnerLevel,
      issues,
      naturalRewrite: review.natural_rewrite,
      brackets,
      usedWell: review.used_well,
      rejectedCount: rejected.length,
      selfFix: {},
      flagged: [],
      explainMore: {},
      levelHeadline: levels.headline,
      wordsUsed: levels.wordsUsed,
      errorsPer100Chars: errorsPer100Chars(issues.length, text),
      createdAt: now,
      sentences: attachModelReviews(prepared, raw.sentences, raw.servedBy),
    };
    await this.db.transaction('rw', this.db.journalEntries, this.db.journalReviews, async () => {
      await this.db.journalEntries.add(entry);
      await this.db.journalReviews.add(reviewRow);
    });
    saveProgressNow(); // Phase 28
    return { entry, review: reviewRow };
  }

  private explainLLM(): ExplainLLM | undefined {
    const llm = this.tutorLLM;
    return llm.checkJournalExplanations && llm.explainJournalWhy
      ? {
          checkJournalExplanations: (r) => llm.checkJournalExplanations!(r),
          explainJournalWhy: (r) => llm.explainJournalWhy!(r),
        }
      : undefined;
  }

  private gapLLM(): GapLLM | undefined {
    const llm = this.tutorLLM;
    return llm.fillJournalGap
      ? {
          fillJournalGap: (r) => llm.fillJournalGap!(r),
          verifyJournalSentence: (r) => llm.verifyJournalSentence(r),
        }
      : undefined;
  }

  /** Phase 31 Part A.4: the independent check of every explanation (regenerated once on a fail). */
  private async checkIssues(
    issues: JournalIssue[],
    text: string,
    learnerLevel: Level,
    intendedFor: (issue: JournalIssue) => string | undefined,
  ): Promise<JournalIssue[]> {
    const llm = this.explainLLM();
    if (!llm || issues.length === 0) return issues;
    return checkExplanations(llm, issues, { text, learnerLevel, intendedFor });
  }

  /** The learner's meaning for the sentence holding `span`: a fixed "Read as" first, then the
   * entry's "What did you mean?". */
  private intendedFor(
    entry: Pick<JournalEntryRow, 'text' | 'intendedEn'>,
    review: Pick<JournalReviewRow, 'meanings'> | undefined,
    span: readonly [number, number],
  ): string | undefined {
    return review?.meanings?.[sentenceRange(entry.text, span)[0]] ?? entry.intendedEn;
  }

  /**
   * Phase 31 Part D: each gap gets up to 3 options that fit its sentence (an in-context Gemini
   * pick among the lexicon matches and its own idea, each filled sentence independently checked).
   * Nothing is added to review here: every option has its own "Add to review".
   */
  private async resolveBrackets(
    text: string,
    gaps: ReturnType<typeof extractBrackets>,
    review: JournalReview,
    learnerLevel: Level,
    intendedEn: string | undefined,
  ): Promise<ResolvedBracket[]> {
    const resolved: ResolvedBracket[] = [];
    const seen = new Set<string>();
    for (const gap of gaps) {
      const en = gap.en;
      if (seen.has(en.toLowerCase())) continue;
      seen.add(en.toLowerCase());
      const options = await resolveGap(this.gapLLM(), this.lexicon, {
        text,
        gap,
        learnerLevel,
        ...(intendedEn ? { intendedEn } : {}),
      });
      // the review's own translation is a last resort, shown only when nothing else was found
      const fromLlm = review.brackets.find((b) => b.en.trim().toLowerCase() === en.toLowerCase());
      if (options.length === 0 && fromLlm && checkTaiwanness(fromLlm.zh).isClean) {
        const word = this.lexicon.lookup(fromLlm.zh)[0];
        options.push({
          zh: fromLlm.zh,
          pinyin: word?.pinyin ?? '',
          meaningEn: word?.glossEn ?? en,
          usageEn: '',
          corrected: '',
          checked: false,
          ...(word ? { wordId: word.id } : {}),
        });
      }
      const first = options[0];
      resolved.push({
        en,
        zh: first?.zh ?? '',
        ...(first?.wordId ? { wordId: first.wordId } : {}),
        source: !first ? 'unresolved' : first.checked ? 'llm' : 'lexicon',
        options,
        added: [],
      });
    }
    return resolved;
  }

  /** Phase 31 Part D.3: "Add to review" on one gap option (nothing is ever added by itself). */
  async addGapWord(entryId: string, en: string, zh: string, now: Date = new Date()): Promise<void> {
    const review = await this.getReview(entryId);
    const bracket = review?.brackets.find((b) => b.en === en);
    const option = bracket?.options?.find((o) => o.zh === zh);
    if (!review || !bracket || !option) throw new JournalError('Unknown gap option.');
    if (bracket.added?.includes(zh)) return;
    let word: Word | undefined =
      (option.wordId ? this.lexicon.byId(option.wordId) : undefined) ?? this.lexicon.lookup(zh)[0];
    if (!word) {
      if (!checkTaiwanness(zh).isClean) throw new JournalError('Please use traditional characters and Taiwan wording.');
      word = { ...buildCustomWord(zh, option.pinyin, option.meaningEn || en), tags: ['journal-gap'] };
      await this.db.customWords.put(word);
    }
    await this.addPriorityItem(word, now);
    await this.db.journalReviews.update(entryId, {
      brackets: review.brackets.map((b) => (b === bracket ? { ...b, added: [...(b.added ?? []), zh] } : b)),
    });
  }

  private async addPriorityItem(word: Word, now: Date): Promise<void> {
    const item = { kind: 'word', id: word.id } as const;
    // Phase 21: one evidence kind (a production lookup plus the priority flag), so the flag is
    // written through applyEvidence like every other card change and syncs with it.
    await this.learnerService.record(
      { item, skill: 'production', kind: 'journal_priority', at: now, context: { source: 'journal' } },
      now,
    );
  }

  /** Phase 31 Part A.4: explanations that couldn't be checked (offline) are checked again. */
  async retryExplanations(entryId: string): Promise<boolean> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    if (!entry || !review || !review.issues.some((i) => i.explainStatus === 'pending')) return false;
    const issues = await this.checkIssues(review.issues, entry.text, review.learnerLevel, (i) =>
      this.intendedFor(entry, review, i.span),
    );
    await this.db.journalReviews.update(entryId, { issues });
    return true;
  }

  /** Phase 31 Part C.1: "Ask about this", a short focused chat (up to 5 turns) saved with the entry. */
  async ask(
    entryId: string,
    issueIndex: number,
    question: string,
    knownWords: readonly string[] = [],
    now: Date = new Date(),
  ): Promise<JournalAskTurn[]> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    const issue = review?.issues[issueIndex];
    if (!entry || !review || !issue) throw new JournalError('Unknown issue.');
    if (!this.tutorLLM.askJournal) throw new JournalError('Asking is not available right now.');
    const q = question.trim().slice(0, 400);
    if (!q) throw new JournalError('Type a question first.');
    const turns = review.asks?.[issueIndex] ?? [];
    if (turns.length >= JOURNAL_ASK_MAX_TURNS) throw new JournalError('That’s the most questions for one correction.');
    const e = issue.explain;
    const explanation = e
      ? [e.wrongEn, e.fixEn, `${e.exampleWrong} ✗ → ${e.exampleRight} ✓`, e.nativeEn ?? ''].filter(Boolean).join(' ')
      : issue.explanationEn;
    const res = await this.tutorLLM.askJournal({
      sentence: contextAround(entry.text, issue.span),
      original: entry.text.slice(issue.span[0], issue.span[1]),
      correction: issue.correction,
      explanation: explanation.slice(0, 1200),
      learnerLevel: review.learnerLevel,
      knownWords: knownWords.filter((w) => w.length <= 12).slice(0, 80),
      history: turns.map((t) => ({ q: t.q, a: t.a })),
      question: q,
    });
    const turn: JournalAskTurn = {
      q,
      a: res.answerEn,
      examples: res.examples.filter((x) => checkTaiwanness(x.zh).isClean),
      at: now,
    };
    const fresh = (await this.getReview(entryId)) ?? review;
    const next = [...(fresh.asks?.[issueIndex] ?? []), turn];
    await this.db.journalReviews.update(entryId, { asks: { ...(fresh.asks ?? {}), [issueIndex]: next } });
    return next;
  }

  /**
   * Phase 31 Part C.2: "What did you mean?" after the fact. With `sentenceStart`, it fixes the
   * "Read as" of that sentence; without, it is the whole entry's meaning. Either way the entry is
   * checked again aiming at that meaning (only before it is finished). Self-fixes, flags and
   * questions about the old corrections are cleared with them.
   */
  async setMeaning(
    entryId: string,
    meaningEn: string,
    sentenceStart?: number,
    now: Date = new Date(),
  ): Promise<void> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    if (!entry || !review) throw new JournalError('Unknown entry.');
    if (entry.status === 'finished') throw new JournalError('This entry is finished.');
    const en = meaningEn.trim().slice(0, 300);
    if (!en) throw new JournalError('Say what you meant first.');
    const meanings = sentenceStart === undefined ? { ...(review.meanings ?? {}) } : { ...(review.meanings ?? {}), [sentenceStart]: en };
    const entryMeaning = sentenceStart === undefined ? en : entry.intendedEn;
    const parts = [
      ...(entryMeaning ? [entryMeaning] : []),
      ...Object.entries(meanings).map(
        ([s, m]) => `"${contextAround(entry.text, [Number(s), Number(s) + 1])}" means: ${m}`,
      ),
    ];
    const intendedEn = parts.join(' | ').slice(0, 400);

    const prepared = prepareSentences(entry.text);
    const protectedTerms = await getProtectedTerms(this.db);
    const gaps = extractBrackets(entry.text);
    const raw = await this.tutorLLM.reviewJournal({
      text: entry.text,
      learnerLevel: review.learnerLevel,
      promptWords: entry.promptWordIds.flatMap((id) => this.lexicon.byId(id)?.headword ?? []),
      recurringPatterns: [],
      maxIssues: this.config.maxIssues,
      sentences: prepared.map((p) => p.original),
      protectedTerms,
      intendedEn,
    });
    const { review: validated, rejected } = validateJournalReview(raw, {
      lexicon: this.lexicon,
      text: entry.text,
      maxIssues: this.config.maxIssues,
      bracketRanges: gaps.map((g): [number, number] => [g.start, g.end]),
    });
    const draftEntry = { ...entry, ...(entryMeaning ? { intendedEn: entryMeaning } : {}) };
    const draftReview = { ...review, meanings };
    const issues = await this.checkIssues(validated.issues, entry.text, review.learnerLevel, (i) =>
      this.intendedFor(draftEntry, draftReview, i.span),
    );
    await this.db.transaction('rw', this.db.journalEntries, this.db.journalReviews, async () => {
      await this.db.journalEntries.update(entryId, {
        status: issues.length > 0 ? 'self_correcting' : 'revealed',
        ...(entryMeaning ? { intendedEn: entryMeaning } : {}),
      });
      await this.db.journalReviews.update(entryId, {
        issues,
        naturalRewrite: validated.natural_rewrite,
        usedWell: validated.used_well,
        rejectedCount: rejected.length,
        selfFix: {},
        flagged: [],
        explainMore: {},
        asks: {},
        disputes: {},
        meanings,
        errorsPer100Chars: errorsPer100Chars(issues.length, entry.text),
        sentences: attachModelReviews(prepared, raw.sentences, raw.servedBy),
        verifiedSentences: [],
      });
    });
    void now;
  }

  /**
   * Phase 31 Part C.3: "I think mine is right". The learner's own sentence goes to the
   * independent check with their meaning. If it agrees, the correction is removed (never
   * practised; on a finished entry its error-bank items and evidence are undone); otherwise it
   * stays, with the check's reason. Either way the dispute is logged on the Reported page.
   */
  async dispute(entryId: string, issueIndex: number, now: Date = new Date()): Promise<JournalDispute> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    const issue = review?.issues[issueIndex];
    if (!entry || !review || !issue) throw new JournalError('Unknown issue.');
    const intendedEn = this.intendedFor(entry, review, issue.span) ?? issue.meaningEn ?? '';
    const sentence = contextAround(entry.text, issue.span);
    const v = await this.tutorLLM.verifyJournalSentence({ zh: sentence, ...(intendedEn ? { en: intendedEn } : {}) });
    const upheld = v.ok && v.meaningMatches;
    const record: JournalDispute = {
      at: now,
      verdict: upheld ? 'upheld' : 'still_wrong',
      intendedEn,
      ...(upheld ? {} : { problem: v.problem || (v.meaningMatches ? '' : 'It doesn’t say what you meant.') }),
    };
    await this.db.journalReviews.update(entryId, { disputes: { ...(review.disputes ?? {}), [issueIndex]: record } });
    if (upheld && entry.status === 'finished') await this.undoFinishedIssue(entry, review, issue, now);
    return record;
  }

  /** A correction removed after the entry was finished: its error-bank items go, and its
   * misuse evidence is taken back (`evidence_undone`, which the ledger drops). */
  private async undoFinishedIssue(
    entry: JournalEntryRow,
    review: JournalReviewRow,
    issue: JournalIssue,
    now: Date,
  ): Promise<void> {
    const sentences = (review.verifiedSentences ?? []).filter(
      (v) => v.start < issue.span[1] && issue.span[0] < v.end,
    );
    const items = await this.db.errorItems.where('journalEntryId').equals(entry.id).toArray();
    for (const it of items) {
      if (it.status === 'deleted') continue;
      if (!sentences.some((v) => v.original === it.original)) continue;
      await this.db.errorItems.put({ ...it, status: 'deleted', blockedReason: 'removed: the learner was right' });
    }
    if (!issue.itemRef) return;
    const ref = issue.itemRef;
    const rows = await this.db.evidence
      .filter(
        (e) =>
          e.kind === 'journal_misuse' &&
          e.context?.refId === entry.id &&
          e.item.kind === ref.kind &&
          e.item.id === ref.id,
      )
      .toArray();
    for (const row of rows) {
      if (!row.uid) continue;
      const prior = review.misusePrior?.[`${ref.kind}:${ref.id}`];
      const later = await this.db.evidence
        .filter((e) => e.item.id === ref.id && e.skill === 'production' && e.at > row.at)
        .count();
      const undo: Evidence = {
        item: ref,
        skill: 'production',
        kind: 'evidence_undone',
        at: now,
        context: { source: 'journal', refId: row.uid, ...(prior ? { restore: prior } : {}) },
      };
      // the card goes back only if nothing has answered it since; otherwise only the record
      // is taken back (the ledger drops undone evidence)
      if (later === 0 && prior !== undefined) await this.learnerService.record(undo, now);
      else await this.db.evidence.add({ ...undo, uid: crypto.randomUUID() } as never);
    }
  }

  /** Phase 31 Part D.4: bracket words the old rule (Phase 5) added to review by itself are listed
   * on the Reported page ("Added from a journal gap. Keep?"). One with several lexicon matches
   * (the rule picked blindly, like 宜人 for "nice") is pre-flagged. Runs once per profile. */
  async migrateLegacyGaps(): Promise<number> {
    const KEY = 'phase31-legacy-gaps';
    if (await this.db.meta.get(KEY)) return 0;
    let n = 0;
    const reviews = await this.db.journalReviews.toArray();
    for (const r of reviews) {
      if (!r.brackets.some((b) => b.wordId && b.source !== 'unresolved' && !b.options && !b.legacy)) continue;
      const brackets = r.brackets.map((b) => {
        if (!b.wordId || b.source === 'unresolved' || b.options || b.legacy) return b;
        n++;
        const ambiguous = gapCandidates(b.en, this.lexicon).length > 1;
        return { ...b, legacy: ambiguous ? ('flagged' as const) : ('ask' as const) };
      });
      await this.db.journalReviews.update(r.entryId, { brackets });
    }
    await this.db.meta.put({ key: KEY, value: new Date() });
    return n;
  }

  /** Reported page: Keep or Remove one old gap word ("Remove" takes it out of review, with Undo
   * from Settings → Removed words like any Nope). */
  async settleLegacyGap(entryId: string, en: string, keep: boolean, now: Date = new Date()): Promise<void> {
    const review = await this.getReview(entryId);
    const bracket = review?.brackets.find((b) => b.en === en && b.legacy);
    if (!review || !bracket) throw new JournalError('Unknown gap.');
    if (!keep && bracket.wordId)
      await this.learnerService.nope({ kind: 'word', id: bracket.wordId }, 'never', {}, now);
    await this.db.journalReviews.update(entryId, {
      brackets: review.brackets.map((b) => (b === bracket ? { ...b, legacy: keep ? 'kept' : 'removed' } : b)),
    });
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
        const sentence = contextAround(entry.text, issue.span);
        const res = await this.tutorLLM.checkJournalFix({
          sentence,
          original,
          attempt: trimmed,
          correction: issue.correction,
        });
        // Phase 31 Part B: the feedback line is built from fields. Other wordings are shown only
        // with their meaning checked against the learner's ("does this mean the same?").
        const intendedEn = this.intendedFor(entry, review, issue.span) ?? issue.meaningEn;
        const alternatives =
          intendedEn && res.alternatives.length > 0
            ? await checkAlternativeMeanings(this.tutorLLM, {
                sentence,
                original,
                intendedEn,
                alternatives: res.alternatives,
              })
            : [];
        record = {
          attempt: trimmed,
          fixed: res.acceptable,
          alternative: res.acceptable,
          // the reason is only shown when it is still off; a right answer shows the "Why?"
          ...(res.acceptable ? {} : { note: res.noteEn }),
          ...(alternatives.length > 0 ? { alternatives } : {}),
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
      .filter(({ index }) => !notPractised(review).has(index));

    const promptWords = entry.promptWordIds
      .map((id) => this.lexicon.byId(id))
      .filter((w): w is Word => Boolean(w));
    const wrongSpans = kept.map(({ issue }) => issue.span);
    const promptWordsUsed = [...findWordsUsed(entry.text, promptWords, this.lexicon, wrongSpans)];
    const flaggedSpans = [...notPractised(review)].flatMap((i) => (review.issues[i] ? [review.issues[i]!.span] : []));

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
      this.db.journalEntries,
      this.db.journalReviews,
      async () => {
        await this.db.journalEntries.update(entryId, { status: 'finished', finishedAt: now });
        await this.db.journalReviews.update(entryId, {
          errorsPer100Chars: errorsPer100Chars(kept.length, entry.text),
        });
      },
    );
    if (evidence.length > 0) {
      // Phase 31: what each misused item's card was before, so "I think mine is right" can undo it
      const repo = new DexieLearnerRepo(this.db);
      const misusePrior: Record<string, SkillCard | null> = {};
      for (const e of evidence.filter((x) => x.kind === 'journal_misuse'))
        misusePrior[`${e.item.kind}:${e.item.id}`] = (await repo.getCard(e.item, 'production')) ?? null;
      await this.db.journalReviews.update(entryId, { misusePrior });
      await this.learnerService.recordBulk(evidence, now);
    }
    // Phase 17: fully corrected sentences -> checked -> review items. If a model
    // can't be reached the entry is retried later (nothing wrong is ever shown).
    const built = await this.processEntry(entryId, now).catch(() => ({ items: 0, complete: false }));
    if (this.onFinished) {
      const selfFixed = kept
        .filter(({ index }) => review.selfFix[index]?.fixed === true)
        .map(({ index }) => index);
      await this.onFinished(entryId, selfFixed, now);
    }
    saveProgressNow(); // Phase 28: a finished entry reaches the server straight away
    return { errorItemCount: built.items, evidence };
  }

  /** The sentence cache is the verified sentences already stored on review rows. */
  private async sentenceCache(): Promise<SentenceCache & { fresh: Map<string, VerifiedSentence> }> {
    const known = new Map<string, VerifiedSentence>();
    await this.db.journalReviews.each((r) => {
      for (const v of r.verifiedSentences ?? []) known.set(v.id, v);
    });
    const fresh = new Map<string, VerifiedSentence>();
    return {
      fresh,
      get: async (key) => known.get(key) ?? fresh.get(key),
      set: async (key, v) => void fresh.set(key, v),
    };
  }

  /**
   * Phase 17 Parts A-C for one finished entry: the stored fully corrected
   * sentences (fetched now for an entry that has none, e.g. one written before
   * Phase 17) -> Part B check -> items. Nothing is written unless every
   * sentence could be checked and built, so an unreachable model just means
   * "try again later". Old one-span-patched items of the entry are replaced
   * (schedule carried over where the tested word is the same) or blocked with
   * the reason, and the new items replace them in one transaction.
   */
  async processEntry(
    entryId: string,
    now: Date = new Date(),
  ): Promise<{ items: number; complete: boolean }> {
    const [entry, review] = await Promise.all([this.getEntry(entryId), this.getReview(entryId)]);
    if (!entry || !review) throw new JournalError('Unknown entry.');
    const protectedTerms = await getProtectedTerms(this.db);

    let raws = review.sentences;
    if (!raws) {
      const prepared = prepareSentences(entry.text);
      const res = await this.tutorLLM.reviewJournal({
        text: entry.text,
        learnerLevel: review.learnerLevel,
        promptWords: [],
        recurringPatterns: [],
        maxIssues: 1,
        sentences: prepared.map((p) => p.original),
        protectedTerms,
        sentencesOnly: true,
      });
      raws = attachModelReviews(prepared, res.sentences, res.servedBy);
    }

    const cache = await this.sentenceCache();
    const deps = {
      lexicon: this.lexicon,
      llm: this.tutorLLM,
      protectedTerms,
      learnerLevel: review.learnerLevel,
      now,
    };
    const verified = await verifyEntrySentences({ ...deps, cache }, raws);
    // a sentence the learner's flag called wrong never feeds the bank
    const flaggedSpans = [...notPractised(review)].flatMap((i) => (review.issues[i] ? [review.issues[i]!.span] : []));
    const eligible = verified.sentences.filter(
      (v) => !flaggedSpans.some(([a, b]) => a < v.end && v.start < b),
    );
    const built = await buildEntryItems(deps, entryId, eligible);
    const complete = verified.pending.length === 0 && built.failed.length === 0;

    const existing = await this.db.errorItems.where('journalEntryId').equals(entryId).toArray();
    const legacy = existing.filter(
      (i) => isLegacyErrorItem(i) && i.status !== 'reported' && i.status !== 'deleted',
    );
    const have = new Set(existing.filter((i) => !isLegacyErrorItem(i)).map((i) => i.id));
    const fresh: ErrorItem[] = built.items
      .filter((i) => !have.has(i.id))
      .map((item) => withWhy(item, review, verified.sentences));

    const reasonFor = (old: ErrorItem): string => {
      const sentence = verified.sentences.find(
        (v) => old.original.includes(v.original) || v.original.includes(old.original),
      );
      if (!sentence) return 'rebuild: the sentence could not be found again';
      if (sentence.status === 'rejected') return `rebuild: ${sentence.reason ?? 'no fully correct version could be verified'}`;
      if (sentence.edits.length === 0) return 'rebuild: the sentence was already correct';
      const dropped = built.dropped.find((d) => d.sentenceId === sentence.id);
      return `rebuild: ${dropped?.reason ?? 'no exercise could be built for this change'}`;
    };

    await this.db.transaction('rw', this.db.errorItems, this.db.journalReviews, async () => {
      if (complete) {
        const outcome = carryOverSchedule(legacy, fresh, reasonFor);
        if (outcome.items.length > 0) await this.db.errorItems.bulkPut(outcome.items);
        const blocked = new Map(outcome.blocked.map((b) => [b.id, b.reason]));
        for (const old of legacy) {
          const reason = blocked.get(old.id);
          await this.db.errorItems.put(
            reason !== undefined
              ? blockErrorItem(old, reason)
              : { ...old, status: 'deleted', blockedReason: 'replaced by rebuilt items' },
          );
        }
      }
      await this.db.journalReviews.update(entryId, {
        sentences: raws,
        verifiedSentences: verified.sentences,
        ...(complete ? { itemsBuiltAt: now } : {}),
      });
    });
    return {
      items: complete ? fresh.filter((i) => i.status === 'active').length : 0,
      complete,
    };
  }

  /**
   * Part E: every finished entry that hasn't had its items built (written
   * before Phase 17, or interrupted) is processed now. Old items are replaced
   * or blocked; none of them are ever shown meanwhile.
   */
  async rebuildPending(now: Date = new Date()): Promise<{ done: number; waiting: number }> {
    const reviews = await this.db.journalReviews.filter((r) => !r.itemsBuiltAt).toArray();
    let done = 0;
    let waiting = 0;
    for (const r of reviews) {
      const entry = await this.getEntry(r.entryId);
      if (!entry || entry.status !== 'finished') continue;
      try {
        const out = await this.processEntry(r.entryId, now);
        if (out.complete) done++;
        else waiting++;
      } catch {
        waiting++;
      }
    }
    // old items whose entry is gone can't be rebuilt
    const orphans = await this.db.errorItems
      .filter((i) => isLegacyErrorItem(i) && i.status !== 'reported' && i.status !== 'deleted' && i.status !== 'blocked')
      .toArray();
    for (const old of orphans) {
      if (!(await this.getEntry(old.journalEntryId)))
        await this.db.errorItems.put(blockErrorItem(old, 'rebuild: the journal entry no longer exists'));
    }
    return { done, waiting };
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

/** Phase 31: issue indexes never practised: flagged by the learner, an explanation that failed the
 * check twice ("We're not sure about this one"), or a dispute the learner won. */
export function notPractised(review: Pick<JournalReviewRow, 'issues' | 'flagged' | 'disputes'>): Set<number> {
  const out = new Set(review.flagged);
  review.issues.forEach((issue, i) => {
    if (issue.explainStatus === 'unsure') out.add(i);
    if (review.disputes?.[i]?.verdict === 'upheld') out.add(i);
  });
  return out;
}

/** Phase 31 Part E: an error-bank item keeps the checked "Why?" (and the linked item) of the
 * correction it practises, found by where the change sits in the entry. */
function withWhy(
  item: ErrorItem,
  review: JournalReviewRow,
  sentences: readonly { original: string; start: number }[],
): ErrorItem {
  const s = sentences.find((v) => v.original === item.original);
  if (!s) return item;
  const at: [number, number] = [s.start + item.span[0], s.start + Math.max(item.span[1], item.span[0] + 1)];
  const issue = review.issues.find(
    (i) => i.explainStatus === 'checked' && i.explain && i.span[0] < at[1] && at[0] < i.span[1],
  );
  if (!issue?.explain) return item;
  return {
    ...item,
    why: issue.explain,
    ...(issue.pattern && !item.pattern ? { pattern: issue.pattern } : {}),
    ...(issue.itemRef && !item.itemRef ? { itemRef: issue.itemRef } : {}),
  };
}
