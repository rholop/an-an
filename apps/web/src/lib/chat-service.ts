import {
  analyzeText,
  derivedCompoundIds,
  lessonScopedWordIds,
  nextNewItems,
  studyTargetWordIds,
  type StudyFocus,
  resolveScenarioVocabExtraIds,
  segment,
  type AnalyzeContext,
  type AnalyzeResult,
  type ClassScope,
  type Evidence,
  type Lexicon,
  type Scenario,
  type SkillCard,
  type TurnHistoryEntry,
  type Textbook,
  type TurnRequest,
  type TurnResponse,
  type TutorLLM,
  wordInScope,
} from '@anan/core';
import type { AnanDB, ConversationRow, TurnRow } from '../db/schema.js';
import type { LearnerService } from './learner-service.js';

export interface ChatServiceConfig {
  coverageThreshold?: number;
  maxUnknownTokens?: number;
  maxRegenerations: number;
  knownSampleSize: number;
  dueSampleSize: number;
  newTargetsPerTurn: number;
}

export const DEFAULT_CHAT_SERVICE_CONFIG: ChatServiceConfig = {
  maxRegenerations: 2,
  knownSampleSize: 30,
  dueSampleSize: 10,
  newTargetsPerTurn: 3,
};

/** Phase 12 "My class", read fresh on every turn. Absent or `scope.enabled`
 * false means chat behaves exactly as before. */
export interface ClassChatContext {
  scope: ClassScope;
  /** Every imported book of the course, in course order (Phase 13). */
  books: Textbook[];
}

export interface SendTurnResult {
  npcTurn: TurnRow;
  report: AnalyzeResult;
  attempts: number;
}

export interface ChatSummary {
  turnCount: number;
  avgCoverage: number;
  goalStepsDone: string[];
  wordsEncountered: string[];
}

function sample<T>(arr: T[], n: number, rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

function buildFeedback(report: AnalyzeResult): string {
  const offending = [...new Set(report.unknown.map((c) => c.token.text))].slice(0, 8);
  return (
    `Your last reply used words outside the learner's current level/budget: ${offending.join('、')}. ` +
    `Replace them with simpler, in-budget alternatives (or drop the idea entirely) and try again. ` +
    `Coverage was ${(report.coverage * 100).toFixed(0)}%; aim for at least ${(DEFAULT_CHAT_SERVICE_CONFIG.coverageThreshold ?? 0.95) * 100}%.`
  );
}

export class ChatService {
  constructor(
    private readonly db: AnanDB,
    private readonly lexicon: Lexicon,
    private readonly learnerService: LearnerService,
    private readonly tutorLLM: TutorLLM,
    private readonly config: ChatServiceConfig = DEFAULT_CHAT_SERVICE_CONFIG,
    private readonly rng: () => number = Math.random,
    /** Phase 6: called once when a conversation completes (all goals done). */
    private readonly onCompleted?: (conversation: ConversationRow) => Promise<void>,
    private readonly classContext?: () => ClassChatContext | undefined,
    /** Phase 14: the study order's focus, so ANY scenario's target words come from unmastered textbook items first. */
    private readonly studyFocus?: () => Promise<StudyFocus | undefined>,
  ) {}

  /** Starts a conversation: the scenario's opener is authored data, not
   * LLM-generated, so this never calls the LLM. */
  async startConversation(scenario: Scenario, now: Date = new Date()): Promise<number> {
    const conversationId = await this.db.conversations.add({
      scenarioId: scenario.id,
      npcId: scenario.npc.id,
      startedAt: now,
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
    });
    await this.db.turns.add({
      conversationId: conversationId as number,
      role: 'npc',
      zh: scenario.opener.zh,
      en: scenario.opener.en,
      at: now,
    });
    return conversationId as number;
  }

  async getTurns(conversationId: number): Promise<TurnRow[]> {
    return this.db.turns.where('conversationId').equals(conversationId).sortBy('id');
  }

  /** phase doc §7: every due/learning token in the PREVIOUS npc message
   * that was NOT looked up becomes chat_read_no_lookup evidence. Call this
   * once, right before sending the learner's reply, with the set of word
   * ids the UI recorded a lookup/hover for on that message. */
  async recordNoLookupEvidence(
    npcText: string,
    lookedUpWordIds: ReadonlySet<string>,
    now: Date = new Date(),
  ): Promise<void> {
    const tokens = segment(npcText, this.lexicon);
    const events: Evidence[] = [];
    for (const token of tokens) {
      if (token.kind !== 'word') continue;
      const candidates = this.lexicon.lookup(token.text);
      for (const word of candidates) {
        const card = await this.learnerService.getCard(
          { kind: 'word', id: word.id },
          'recognition',
        );
        if (!card) continue;
        const isDueOrLearning = card.state === 'learning' || card.card.due <= now;
        if (isDueOrLearning && !lookedUpWordIds.has(word.id)) {
          events.push({
            item: { kind: 'word', id: word.id },
            skill: 'recognition',
            kind: 'chat_read_no_lookup',
            at: now,
          });
        }
        break; // first matching sense is enough to attribute the signal
      }
    }
    if (events.length > 0) await this.learnerService.recordBulk(events, now);
  }

  private async buildAnalyzeContext(
    learnerLevel: AnalyzeContext['learnerLevel'],
    targetIds: string[],
    allowedExtraIds: string[],
  ): Promise<AnalyzeContext> {
    const [knownIds, dueCards] = await Promise.all([
      this.learnerService.knownSet('review'),
      this.learnerService.dueCards(new Date(), 10_000),
    ]);
    const dueIds = new Set(dueCards.filter((c) => c.skill === 'recognition').map((c) => c.item.id));
    const learningIds = new Set<string>(); // learning-state cards are a subset not separately tracked by knownSet; acceptable to omit for Phase 3's first cut
    return {
      lexicon: this.lexicon,
      learnerLevel,
      knownIds,
      dueIds,
      targetIds: new Set(targetIds),
      learningIds,
      allowedExtraIds: new Set(allowedExtraIds),
    };
  }

  /** Phase 7 §B4: candidate sense ids for the target/extra words that have
   * more than one sense — only those, capped, to keep the prompt small. The
   * model picks an id per token; it never writes a definition. */
  private senseOptionsFor(ids: string[]): NonNullable<TurnRequest['vocab']['senseOptions']> {
    const out: NonNullable<TurnRequest['vocab']['senseOptions']> = [];
    for (const id of new Set(ids)) {
      const word = this.lexicon.byId(id);
      if (!word?.senses || word.senses.length < 2) continue;
      out.push({
        word: word.headword,
        senses: word.senses.map((s) => ({ id: s.id, gloss: s.glossEn })),
      });
      if (out.length >= 8) break;
    }
    return out;
  }

  /** The model may only name a sense id it was offered; anything else is
   * dropped, and the UI then falls back to context rules / the primary sense. */
  private sanitizeSenseIds(
    tokens: TurnResponse['tokens'],
    offered: NonNullable<TurnRequest['vocab']['senseOptions']>,
  ): TurnResponse['tokens'] {
    const valid = new Set(offered.flatMap((o) => o.senses.map((s) => s.id)));
    return tokens.map((t) => {
      if (t.sense_id === undefined) return t;
      const { sense_id, ...rest } = t;
      return valid.has(sense_id) ? t : rest;
    });
  }

  private headwordsOf(ids: string[]): string[] {
    return ids.map((id) => this.lexicon.byId(id)?.headword).filter((w): w is string => Boolean(w));
  }

  async sendLearnerTurn(
    conversationId: number,
    scenario: Scenario,
    learnerText: string,
    options: {
      learnerLevel: TurnRequest['learnerLevel'];
      scaffolding: TurnRequest['scaffolding'];
      englishFallback: boolean;
    },
    now: Date = new Date(),
  ): Promise<SendTurnResult> {
    await this.db.turns.add({ conversationId, role: 'learner', zh: learnerText, at: now });
    if (options.englishFallback)
      await this.db.conversations.update(conversationId, { englishFallbackUsed: true });

    const priorTurns = await this.getTurns(conversationId);
    const history: TurnHistoryEntry[] = priorTurns.map((t) => ({
      role: t.role,
      zh: t.zh,
      en: t.en,
    }));

    const klass = this.classContext?.();
    const scope = klass?.scope.enabled ? klass.scope : undefined;
    const [knownAll, { ids: scenarioExtraIds }] = await Promise.all([
      this.learnerService.knownSet('review'),
      Promise.resolve(resolveScenarioVocabExtraIds(scenario, this.lexicon)),
    ]);
    // My class: textbook words from lessons beyond current+1 stay out of the known sample.
    const knownCards = scope
      ? new Set([...knownAll].filter((id) => {
          const w = this.lexicon.byId(id);
          return !w || wordInScope(w, scope);
        }))
      : knownAll;
    // A textbook scenario may use every word of lessons ≤ its own (plus obvious
    // compounds of them) — the validator allows those; the model is shown the
    // scenario's own list plus its lesson's vocabulary.
    let allowedExtraIds = scenarioExtraIds;
    let validatorExtraIds = scenarioExtraIds;
    if (scenario.textbook && klass) {
      const { textbookId, lesson } = scenario.textbook;
      const scoped = lessonScopedWordIds(klass.books, lesson, { bookId: textbookId });
      const lessonOwn =
        klass.books.find((b) => b.id === textbookId)?.lessons[lesson - 1]?.vocab ?? [];
      allowedExtraIds = [...new Set([...scenarioExtraIds, ...lessonOwn])].slice(0, 60);
      validatorExtraIds = [
        ...new Set([...scenarioExtraIds, ...scoped, ...derivedCompoundIds(this.lexicon, scoped)]),
      ];
    }
    const dueCards = await this.learnerService.dueCards(now, 10_000);
    const dueWordIds = dueCards.filter((c) => c.skill === 'recognition').map((c) => c.item.id);
    const allCards: SkillCard[] = dueCards; // best-effort pool for nextNewItems' "touched" check
    const want = this.config.newTargetsPerTurn;
    const studyIds = studyTargetWordIds(await this.studyFocus?.().catch(() => undefined), want);
    const studyWords = studyIds.flatMap((id) => this.lexicon.byId(id) ?? []);
    const targets =
      studyWords.length >= want
        ? studyWords.slice(0, want)
        : [
            ...studyWords,
            ...nextNewItems(allCards, this.lexicon, want, {
              scenarioTags: [scenario.id],
              currentLevel: options.learnerLevel,
              ...(scope ? { classScope: scope } : {}),
            }).filter((w) => !studyIds.includes(w.id)),
          ].slice(0, want);
    const targetIds = targets.map((w) => w.id);

    const req: TurnRequest = {
      scenarioId: scenario.id,
      npcId: scenario.npc.id,
      history,
      learnerLevel: options.learnerLevel,
      vocab: {
        knownSample: this.headwordsOf(
          sample([...knownCards], this.config.knownSampleSize, this.rng),
        ),
        due: this.headwordsOf(sample(dueWordIds, this.config.dueSampleSize, this.rng)),
        targets: this.headwordsOf(targetIds),
        allowedExtras: this.headwordsOf(allowedExtraIds),
        senseOptions: this.senseOptionsFor([...targetIds, ...allowedExtraIds]),
      },
      scaffolding: options.scaffolding,
      englishFallback: options.englishFallback,
    };

    const analyzeCtx = await this.buildAnalyzeContext(
      options.learnerLevel,
      targetIds,
      validatorExtraIds,
    );

    let attempts = 0;
    let response: TurnResponse | undefined;
    let report: AnalyzeResult | undefined;
    let feedback: string | undefined;

    while (attempts <= this.config.maxRegenerations) {
      attempts++;
      response = await this.tutorLLM.generateTurn({ ...req, feedback });
      report = analyzeText(response.reply_zh, analyzeCtx, [], {
        coverageThreshold: 0.95,
        maxUnknownTokens: 4,
        ...this.config,
      });
      if (report.pass) break;
      feedback = buildFeedback(report);
    }

    const finalResponse = response!;
    const finalReport = report!;

    if (!finalReport.pass) {
      // Max attempts exhausted: accept the best attempt, mark the leaked
      // unknown words as introduced (reusing chat_lookup_gloss's
      // introduce-or-relapse effect — see applyEvidence) so they enter the
      // learner model with a gloss the UI can show inline.
      const introduceEvents: Evidence[] = finalReport.unknown
        .filter((c) => c.wordId)
        .map((c) => ({
          item: { kind: 'word', id: c.wordId! },
          skill: 'recognition',
          kind: 'chat_lookup_gloss',
          at: now,
        }));
      if (introduceEvents.length > 0) await this.learnerService.recordBulk(introduceEvents, now);
    }

    const npcTurnId = await this.db.turns.add({
      conversationId,
      role: 'npc',
      zh: finalResponse.reply_zh,
      en: finalResponse.reply_en,
      tokens: this.sanitizeSenseIds(finalResponse.tokens, req.vocab.senseOptions ?? []),
      suggestedReplies: finalResponse.suggested_replies,
      recastZh: finalResponse.recast_zh,
      validatorReport: {
        coverage: finalReport.coverage,
        maxLevel: finalReport.maxLevel,
        unknownCount: finalReport.unknown.length,
        attempts,
        pass: finalReport.pass,
      },
      at: now,
    });

    const doneSteps = finalResponse.goal_progress.filter((g) => g.done).map((g) => g.step);
    if (doneSteps.length > 0) {
      const conv = await this.db.conversations.get(conversationId);
      if (conv) {
        const merged = [...new Set([...conv.goalStepsDone, ...doneSteps])];
        await this.db.conversations.update(conversationId, { goalStepsDone: merged });
      }
    }

    const npcTurn = await this.db.turns.get(npcTurnId as number);
    return { npcTurn: npcTurn!, report: finalReport, attempts };
  }

  /** Phase 6: "I'm stuck" pressed (once per press, however many hint levels
   * that press reveals) — one of the scenario star criteria. */
  async recordStuck(conversationId: number): Promise<void> {
    await this.db.conversations
      .where('id')
      .equals(conversationId)
      .modify((c) => {
        c.stuckCount += 1;
      });
  }

  async endConversation(conversationId: number, now: Date = new Date()): Promise<void> {
    await this.db.conversations.update(conversationId, { endedAt: now });
  }

  /** Once every goal step is done, appends the scenario's authored
   * successLine as a final npc turn (same "authored, not generated" pattern
   * as startConversation's opener) and ends the conversation. Safe to call
   * after every learner turn — a no-op once already ended or incomplete.
   * Returns whether it just completed the conversation. */
  async maybeCompleteConversation(
    conversationId: number,
    scenario: Scenario,
    now: Date = new Date(),
  ): Promise<boolean> {
    const conv = await this.db.conversations.get(conversationId);
    if (!conv || conv.endedAt) return false;
    const allDone = scenario.goalSteps.every((step) => conv.goalStepsDone.includes(step.id));
    if (!allDone) return false;

    await this.db.turns.add({
      conversationId,
      role: 'npc',
      zh: scenario.successLine.zh,
      en: scenario.successLine.en,
      at: now,
    });
    await this.endConversation(conversationId, now);
    await this.db.conversations.update(conversationId, { completed: true });
    const done = await this.db.conversations.get(conversationId);
    if (done && this.onCompleted) await this.onCompleted(done);
    return true;
  }

  async getSummary(conversationId: number): Promise<ChatSummary> {
    const turns = await this.getTurns(conversationId);
    const npcTurns = turns.filter((t) => t.role === 'npc' && t.validatorReport);
    const avgCoverage =
      npcTurns.length > 0
        ? npcTurns.reduce((sum, t) => sum + (t.validatorReport?.coverage ?? 0), 0) / npcTurns.length
        : 1;
    const conversation = await this.db.conversations.get(conversationId);

    // "Words you encountered" (phase doc §7's summary): chat_lookup_gloss and
    // chat_hover_reading evidence recorded during this conversation's time
    // window — covers both explicit taps/hovers AND words auto-introduced
    // after exhausted regenerations (which reuse chat_lookup_gloss's effect,
    // see sendLearnerTurn above). Time-windowed rather than id-tagged since
    // evidence rows don't carry a conversationId (CLAUDE.md keeps the
    // learner model's evidence log scenario-agnostic).
    const lower = conversation?.startedAt ?? new Date(0);
    const upper = conversation?.endedAt ?? new Date();
    const evidenceInRange = await this.db.evidence
      .where('at')
      .between(lower, upper, true, true)
      .toArray();
    const encounteredIds = new Set(
      evidenceInRange
        .filter((e) => e.kind === 'chat_lookup_gloss' || e.kind === 'chat_hover_reading')
        .map((e) => e.item.id),
    );

    return {
      turnCount: turns.length,
      avgCoverage,
      goalStepsDone: conversation?.goalStepsDone ?? [],
      wordsEncountered: this.headwordsOf([...encounteredIds]),
    };
  }
}
