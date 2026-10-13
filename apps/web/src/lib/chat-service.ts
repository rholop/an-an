import {
  analyzeText,
  keptWords,
  type ChatTurnValidation,
  derivedCompoundIds,
  lessonScopedWordIds,
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
  type TurnHistoryEntry,
  type Textbook,
  type TurnRequest,
  type TurnResponse,
  type TutorLLM,
  wordInScope,
  glossFor,
} from '@anan/core';
import type { AnanDB, ConversationRow, TurnRow } from '../db/schema.js';
import type { LearnerService } from './learner-service.js';
import {
  ChatEngine,
  isCleanChinese,
  UnreliableReplyError,
  type ChatEngineDeps,
  type ChatMode,
  type ChatTurnOptions,
  type ModeTurn,
} from './chat-engine.js';

export { isCleanChinese, UnreliableReplyError };

/** The word ids a `ledger.pickNew` result introduces (New cards first, then items with no card). */
export function newWordIds(picked: { cards: readonly { item: { kind: string; id: string } }[]; items: readonly { kind: string; id: string }[] }): string[] {
  return [...new Set([...picked.cards.map((c) => c.item), ...picked.items].filter((i) => i.kind === 'word').map((i) => i.id))];
}

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
  /** Phase 36: the learner's stored message ("Read as", correction, gaps land on it). */
  learnerTurn?: TurnRow;
  /** Phase 36: settles when the message's correction and gap fills are stored. */
  corrections?: Promise<void>;
  /** Phase 36: the reply still contradicted the learner after one regeneration. */
  misunderstood?: boolean;
}

/** Phase 36: a scenario reply's budget check, in the engine's shape. */
type ScenarioReport = AnalyzeResult & ChatTurnValidation;

export interface ChatSummary {
  /** Phase 21: messages the learner sent (both chat types say "N messages from you"). */
  learnerMessages: number;
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
    /** Phase 36: the shared engine's extras (journal corrector, quota check), for tests. */
    listen: Partial<Pick<ChatEngineDeps, 'journal' | 'quotaShort'>> = {},
  ) {
    this.engine = new ChatEngine({
      db,
      lexicon,
      learnerService,
      tutorLLM,
      maxRegenerations: config.maxRegenerations,
      ...listen,
    });
  }

  /** Phase 36: the one chat engine (shared with open chat). */
  readonly engine: ChatEngine;

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

  /** The conversation as shown (Phase 36: replies replaced by "Try again" left out). */
  async getTurns(conversationId: number): Promise<TurnRow[]> {
    return this.engine.visibleTurns(conversationId);
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
    const ledger = await this.learnerService.ledger(now);
    const events: Evidence[] = [];
    // Phase 21: a word read twice in one message is one reading, not two.
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'word') continue;
      const candidates = this.lexicon.lookup(token.text);
      for (const word of candidates) {
        const card = await this.learnerService.getCard(
          { kind: 'word', id: word.id },
          'recognition',
        );
        if (!card || seen.has(word.id)) continue;
        // Phase 29 Part B.11: one read-credit rule (`ledger.creditsRead`).
        if (ledger.creditsRead(card) && !lookedUpWordIds.has(word.id)) {
          seen.add(word.id);
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
    // Phase 29: the one comprehensible set (known / in session / learning), the ledger's.
    const { knownIds, dueIds, learningIds } = (await this.learnerService.ledger(new Date())).comprehensible();
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
      showCorrections?: boolean;
    },
    now: Date = new Date(),
  ): Promise<SendTurnResult> {
    const out = await this.engine.send(conversationId, this.mode(scenario), learnerText, options, now);
    return {
      npcTurn: out.npcTurn,
      report: out.report,
      attempts: out.attempts,
      learnerTurn: out.learnerTurn,
      corrections: out.corrections,
      misunderstood: out.misunderstood,
    };
  }

  /** Phase 36: "Try again" on a reply that may have misunderstood the learner. */
  tryAgain(conversationId: number, scenario: Scenario, options: ChatTurnOptions, now: Date = new Date()) {
    return this.engine.tryAgain(conversationId, this.mode(scenario), options, now);
  }

  /** Phase 36: "What did you mean?" on the learner's last message (the reply is regenerated). */
  fixMeaning(
    conversationId: number,
    learnerTurnId: number,
    meaningEn: string,
    scenario: Scenario,
    options: ChatTurnOptions,
    now: Date = new Date(),
  ) {
    return this.engine.fixMeaning(conversationId, learnerTurnId, meaningEn, this.mode(scenario), options, now);
  }

  /** Phase 36: scenario chat as a mode of the one engine: the persona, scene and goal steps. */
  mode(scenario: Scenario): ChatMode<ScenarioReport> {
    return { prepare: (cid, turns, options, now) => this.prepareTurn(cid, scenario, turns, options, now) };
  }

  private async prepareTurn(
    conversationId: number,
    scenario: Scenario,
    priorTurns: TurnRow[],
    options: ChatTurnOptions,
    now: Date,
  ): Promise<ModeTurn<ScenarioReport>> {
    const history: TurnHistoryEntry[] = priorTurns.map((t) => ({
      role: t.role,
      zh: t.zh,
      en: t.en,
    }));

    const klass = this.classContext?.();
    const scope = klass?.scope.enabled ? klass.scope : undefined;
    const ledger = await this.learnerService.ledger(now);
    const sets = ledger.comprehensible();
    const { ids: scenarioExtraIds } = resolveScenarioVocabExtraIds(scenario, this.lexicon);
    const knownAll = sets.knownIds;
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
        klass.books.find((b) => b.id === textbookId)?.lessons.find((l) => l.n === lesson)?.vocab ?? [];
      allowedExtraIds = [...new Set([...scenarioExtraIds, ...lessonOwn])].slice(0, 60);
      validatorExtraIds = [
        ...new Set([...scenarioExtraIds, ...scoped, ...derivedCompoundIds(this.lexicon, scoped)]),
      ];
    }
    // Phase 36: words the learner typed in this chat never count against the budget (as in open chat).
    const typedIds = priorTurns
      .filter((t) => t.role === 'learner')
      .flatMap((t) => segment(t.zh, this.lexicon))
      .filter((tok) => tok.kind === 'word')
      .flatMap((tok) => this.lexicon.lookup(tok.text).map((w) => w.id));
    const dueWordIds = [...sets.dueIds];
    const want = this.config.newTargetsPerTurn;
    const focus = await this.studyFocus?.().catch(() => undefined);
    const studyIds = studyTargetWordIds(focus, want);
    const studyWords = studyIds.flatMap((id) => this.lexicon.byId(id) ?? []);
    // Phase 39: a tutoring class's chat targets that class's words (not Learned yet first).
    const classWords = scenario.tutor
      ? [...scenarioExtraIds]
          .sort((a, b) => Number(ledger.learned({ kind: 'word', id: a })) - Number(ledger.learned({ kind: 'word', id: b })))
          .flatMap((id) => this.lexicon.byId(id) ?? [])
      : [];
    const targets = classWords.length > 0
      ? classWords.slice(0, want)
      : studyWords.length >= want
        ? studyWords.slice(0, want)
        : [
            ...studyWords,
            // Phase 29 Part B.4: the one new-word picker under the one allowance (a pause stops these too).
            ...newWordIds(ledger.pickNew('review', { scenarioTags: [scenario.id], level: options.learnerLevel }))
              .filter((id) => !studyIds.includes(id))
              .flatMap((id) => this.lexicon.byId(id) ?? []),
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
      // Phase 39: a tutoring class's scenario lives with the class, not in the proxy's scenario files.
      ...(scenario.tutor ? { scenario } : {}),
    };

    const analyzeCtx = await this.buildAnalyzeContext(
      options.learnerLevel,
      targetIds,
      [...validatorExtraIds, ...typedIds],
    );
    const validate = (response: TurnResponse): ScenarioReport => {
      // Phase 36: up to 2 words kept to keep the meaning are allowed (and glossed)
      const kept = keptWords(response).flatMap((t) => this.lexicon.lookup(t).map((w) => w.id));
      const ctx = kept.length > 0 ? { ...analyzeCtx, allowedExtraIds: new Set([...analyzeCtx.allowedExtraIds, ...kept]) } : analyzeCtx;
      const report = analyzeText(response.reply_zh, ctx, [], {
        coverageThreshold: 0.95,
        maxUnknownTokens: 4,
        ...this.config,
      });
      return { ...report, taiwanClean: report.taiwanness.isClean, feedback: buildFeedback(report) };
    };

    return {
      generate: (x) =>
        this.tutorLLM.generateTurn({
          ...req,
          ...(x.feedback ? { feedback: x.feedback } : {}),
          ...(x.alternateModel ? { alternateModel: true } : {}),
          ...(x.facts.length > 0 ? { facts: x.facts } : {}),
          ...(x.learnerMeaningEn ? { learnerMeaningEn: x.learnerMeaningEn } : {}),
        }),
      validate,
      leakedWordIds: (report) => (report.pass ? [] : report.unknown.flatMap((c) => (c.wordId ? [c.wordId] : []))),
      npcFields: (response, report) => ({
        tokens: this.sanitizeSenseIds(response.tokens, req.vocab.senseOptions ?? []),
        // Phase 21: the promised inline glosses for words past the learner's reach (as in open chat).
        ...(report.pass ? {} : { glosses: this.leakGlosses(report.unknown) }),
        validatorReport: {
          coverage: report.coverage,
          maxLevel: report.maxLevel,
          unknownCount: report.unknown.length,
          attempts: 0,
          pass: report.pass,
        },
      }),
      after: async (npcTurn, response) => {
        const doneSteps = response.goal_progress.filter((g) => g.done).map((g) => g.step);
        if (doneSteps.length > 0) {
          const conv = await this.db.conversations.get(conversationId);
          if (conv) {
            const merged = [...new Set([...conv.goalStepsDone, ...doneSteps])];
            await this.db.conversations.update(conversationId, { goalStepsDone: merged });
          }
        }
        void npcTurn;
      },
    };
  }

  /** Phase 6: "I'm stuck" pressed (once per press, however many hint levels
   * that press reveals) — one of the scenario star criteria. */
  private leakGlosses(unknown: ReadonlyArray<{ token: { text: string }; wordId?: string }>): { text: string; gloss: string }[] {
    const seen = new Set<string>();
    return unknown.flatMap((c) => {
      const w = c.wordId ? this.lexicon.byId(c.wordId) : undefined;
      const text = c.token.text;
      if (!w || seen.has(text)) return [];
      seen.add(text);
      return [{ text, gloss: glossFor(w) }];
    });
  }

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
    await this.engine.finishCorrections(conversationId, now); // Phase 36: corrections reach the error bank
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
    // Phase 21: "New words you met" lists only words not already Learned.
    const knownIds = (await this.learnerService.ledger(upper)).learnedWordIds();
    const encounteredIds = new Set(
      evidenceInRange
        .filter((e) => e.kind === 'chat_lookup_gloss' || e.kind === 'chat_hover_reading')
        .map((e) => e.item.id)
        .filter((id) => !knownIds.has(id)),
    );

    return {
      learnerMessages: turns.filter((t) => t.role === 'learner').length,
      turnCount: turns.length,
      avgCoverage,
      goalStepsDone: conversation?.goalStepsDone ?? [],
      wordsEncountered: this.headwordsOf([...encounteredIds]),
    };
  }
}
