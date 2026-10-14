// Phase 18: Open chat. Orchestrates one open-chat turn: builds the tiers from the learner's
// own state, calls the tutor, validates against the tiers, regenerates once with feedback,
// and stores the turn. The LLM never sees more than the tier lists and the last 12 turns.
import {
  buildOpenChatVocab,
  OPEN_CHAT_CONFIG,
  OPEN_CHAT_NPC,
  OPEN_CHAT_OPENERS,
  OPEN_CHAT_TOPIC_OPENER,
  openChatFeedback,
  openChatGlosses,
  openChatHistoryWindow,
  openChatSummaryDue,
  openChatTierMix,
  pickBestOpenChatAttempt,
  segment,
  summarizeOpenChat,
  validateOpenChatTurn,
  keptWords,
  type ChatTurnValidation,
  type Lexicon,
  type Level,
  type OpenChatConfig,
  type OpenChatProfile,
  type OpenChatReport,
  type OpenChatVocab,
  type OpenTurnRequest,
  type StudyFocus,
  type Textbook,
  type TurnResponse,
  type TutorLLM,
  glossFor,
} from '@anan/core';
import type { AnanDB, ConversationRow, TurnRow } from '../db/schema.js';
import type { LearnerService } from './learner-service.js';
import { ChatEngine, type ChatEngineDeps, type ChatMode, type ChatTurnOptions, type ModeTurn } from './chat-engine.js';

export const OPEN_CHAT_SCENARIO_ID = 'open-chat';
const TOPIC_CACHE_KEY = 'openChatTopicWords';
const TOPIC_CACHE_MAX = 60;

/** What the page supplies fresh on every turn (so a changed level or class lesson applies at once). */
export interface OpenChatEnvironment {
  books(): Textbook[];
  studyFocus?(): Promise<StudyFocus | undefined>;
}

export interface OpenTurnOptions {
  learnerLevel: Level;
  scaffolding: OpenTurnRequest['scaffolding'];
  englishFallback: boolean;
  /** Phase 36: Settings → Chat → Show corrections. */
  showCorrections?: boolean;
}

export interface OpenTurnResult {
  npcTurn: TurnRow;
  report: OpenChatReport;
  attempts: number;
  vocab: OpenChatVocab;
  /** Phase 36: as in scenario chat (one engine). */
  learnerTurn?: TurnRow;
  corrections?: Promise<void>;
  misunderstood?: boolean;
}

/** Phase 36: an open-chat reply's tier check, in the engine's shape. */
type OpenReport = OpenChatReport & ChatTurnValidation;

export interface OpenChatSummary {
  turnCount: number;
  learnerTurns: number;
  topic: string;
  /** Share of content words that were known / being learned / in the next lessons. */
  tierShareA: number;
  /** Share of NPC turns that used at least one word from the upcoming lessons. */
  upcomingTurnShare: number;
  /** New words met (tier B/C and upcoming-lesson words), with whether the learner already looked each up. */
  wordsMet: Array<{ wordId: string; headword: string; glossEn: string; lookedUp: boolean }>;
  wordsLookedUp: string[];
}

export interface TopicWordsCacheEntry {
  words: string[];
  at: string;
}

const topicKey = (topic: string, level: Level) =>
  `${level}|${topic.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/** Phase 26: a topic's words when open chat already fetched them (no model call). */
export async function cachedTopicWords(db: AnanDB, topic: string, level: Level): Promise<string[]> {
  const row = await db.meta.get(TOPIC_CACHE_KEY);
  const v = row?.value as Record<string, TopicWordsCacheEntry> | undefined;
  return v?.[topicKey(topic, level)]?.words ?? [];
}

export class OpenChatService {
  constructor(
    private readonly db: AnanDB,
    private readonly lexicon: Lexicon,
    private readonly learnerService: LearnerService,
    private readonly tutorLLM: TutorLLM,
    private readonly env: OpenChatEnvironment,
    private readonly config: OpenChatConfig = OPEN_CHAT_CONFIG,
    private readonly rng: () => number = Math.random,
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

  /** Phase 36: the one chat engine (shared with scenario chat). */
  readonly engine: ChatEngine;

  // ---- topic words (cached on the device: a second open of the same topic makes no call) ----

  private readonly inflight = new Map<string, Promise<string[]>>();

  getTopicWords(topic: string, level: Level): Promise<string[]> {
    const text = topic.trim();
    if (!text) return Promise.resolve([]);
    const key = topicKey(text, level);
    // A prefetch and the first turn may ask at once: share one call.
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.loadTopicWords(text, level, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async loadTopicWords(text: string, level: Level, key: string): Promise<string[]> {
    const cache = await this.readTopicCache();
    const hit = cache[key];
    if (hit) return hit.words;
    if (!this.tutorLLM.generateTopicWords) return [];
    const { words } = await this.tutorLLM.generateTopicWords({ topic: text, level });
    const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))].slice(
      0,
      this.config.topicWordCount * 2,
    );
    if (clean.length > 0) {
      cache[key] = { words: clean, at: new Date().toISOString() };
      const entries = Object.entries(cache)
        .sort((a, b) => b[1].at.localeCompare(a[1].at))
        .slice(0, TOPIC_CACHE_MAX);
      await this.db.meta.put({ key: TOPIC_CACHE_KEY, value: Object.fromEntries(entries) });
    }
    return clean;
  }

  private async readTopicCache(): Promise<Record<string, TopicWordsCacheEntry>> {
    const row = await this.db.meta.get(TOPIC_CACHE_KEY);
    const v = row?.value as Record<string, TopicWordsCacheEntry> | undefined;
    return v && typeof v === 'object' ? { ...v } : {};
  }

  // ---- conversations ------------------------------------------------------------

  /** Starts an open chat. The first line is authored (like scenario openers): with no topic
   * 安安 opens with a simple question, otherwise a short "let's chat" lead-in. */
  async startConversation(topic: string, now: Date = new Date()): Promise<number> {
    const text = topic.trim();
    const conversationId = (await this.db.conversations.add({
      scenarioId: OPEN_CHAT_SCENARIO_ID,
      npcId: OPEN_CHAT_NPC.id,
      startedAt: now,
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
      kind: 'open',
      topic: text,
      summarizedUpTo: 0,
    })) as number;
    const opener = text
      ? OPEN_CHAT_TOPIC_OPENER
      : OPEN_CHAT_OPENERS[Math.floor(this.rng() * OPEN_CHAT_OPENERS.length)]!;
    await this.db.turns.add({ conversationId, role: 'npc', zh: opener.zh, en: opener.en, at: now });
    return conversationId;
  }

  /** "New topic": the next turns use the new topic (and a rebuilt topic word list). */
  async setTopic(conversationId: number, topic: string): Promise<void> {
    await this.db.conversations.update(conversationId, { topic: topic.trim() });
  }

  /** The conversation as shown (Phase 36: replies replaced by "Try again" left out). */
  async getTurns(conversationId: number): Promise<TurnRow[]> {
    return this.engine.visibleTurns(conversationId);
  }

  // ---- the learner's state as a profile ---------------------------------------------

  async buildProfile(level: Level, now: Date): Promise<OpenChatProfile> {
    // Phase 29: the one comprehensible set (the ledger's; the same as scenario chat and the reader).
    const ledger = await this.learnerService.ledger(now);
    const { knownIds: known, dueIds: due, learningIds: learning } = ledger.comprehensible();
    const studyFocus = await this.env.studyFocus?.().catch(() => undefined);
    const tutorWordIds = ledger.recentTutorWordIds();
    return {
      lexicon: this.lexicon,
      level,
      knownIds: known,
      dueIds: due,
      learningIds: learning,
      books: this.env.books(),
      ...(studyFocus ? { studyFocus } : {}),
      ...(tutorWordIds.length > 0 ? { tutorWordIds } : {}),
    };
  }

  /** The tiers for the current topic: used by every turn and by the page's chips. */
  async vocabFor(
    topic: string,
    level: Level,
    now: Date,
    topicWords?: readonly string[],
  ): Promise<OpenChatVocab> {
    const profile = await this.buildProfile(level, now);
    return buildOpenChatVocab(profile, { text: topic, words: topicWords }, now, this.config, this.rng);
  }

  // ---- one turn -----------------------------------------------------------------

  async sendLearnerTurn(
    conversationId: number,
    learnerText: string,
    options: OpenTurnOptions,
    now: Date = new Date(),
  ): Promise<OpenTurnResult> {
    if (!this.tutorLLM.generateOpenTurn) throw new Error('This tutor cannot run open chat.');
    const mode = this.mode();
    const out = await this.engine.send(conversationId, mode, learnerText, options, now);
    return {
      npcTurn: out.npcTurn,
      report: out.report,
      attempts: out.attempts,
      vocab: mode.lastVocab!,
      learnerTurn: out.learnerTurn,
      corrections: out.corrections,
      misunderstood: out.misunderstood,
    };
  }

  /** Phase 36: "Try again" on a reply that may have misunderstood the learner. */
  tryAgain(conversationId: number, options: ChatTurnOptions, now: Date = new Date()) {
    return this.engine.tryAgain(conversationId, this.mode(), options, now);
  }

  /** Phase 36: "What did you mean?" on the learner's last message (the reply is regenerated). */
  fixMeaning(conversationId: number, learnerTurnId: number, meaningEn: string, options: ChatTurnOptions, now: Date = new Date()) {
    return this.engine.fixMeaning(conversationId, learnerTurnId, meaningEn, this.mode(), options, now);
  }

  /** Phase 36: open chat as a mode of the one engine: the persona 安安 and a topic. */
  mode(): ChatMode<OpenReport> & { lastVocab?: OpenChatVocab } {
    const mode: ChatMode<OpenReport> & { lastVocab?: OpenChatVocab } = {
      onLearnerTurn: (now) => this.db.markActiveDay(now), // Phase 32: an open-chat turn keeps the streak growing
      prepare: async (cid, turns, options, now) => {
        const prepared = await this.prepareTurn(cid, turns, options, now);
        mode.lastVocab = prepared.vocab;
        return prepared.turn;
      },
    };
    return mode;
  }

  private async prepareTurn(
    conversationId: number,
    turns: TurnRow[],
    options: ChatTurnOptions,
    now: Date,
  ): Promise<{ turn: ModeTurn<OpenReport>; vocab: OpenChatVocab }> {
    const generate = this.tutorLLM.generateOpenTurn!.bind(this.tutorLLM);
    let conv = (await this.db.conversations.get(conversationId))!;
    const topic = conv.topic ?? '';

    // Long chats: the last 12 turns plus a running summary, refreshed every 6 turns.
    if (openChatSummaryDue(turns.length, conv.summarizedUpTo ?? 0, this.config)) {
      const summary = summarizeOpenChat(
        conv.summary,
        turns.slice(conv.summarizedUpTo ?? 0),
        this.config.history.summaryMaxChars,
      );
      await this.db.conversations.update(conversationId, { summary, summarizedUpTo: turns.length });
      conv = { ...conv, summary, summarizedUpTo: turns.length };
    }
    const { recent } = openChatHistoryWindow(turns, this.config);

    // The topic list is a nicety: if it cannot be had the chat goes on without it.
    const topicWords = await this.getTopicWords(topic, options.learnerLevel).catch(() => []);
    const vocab = await this.vocabFor(topic, options.learnerLevel, now, topicWords);

    // Words the learner typed in this chat never count against a tier.
    const typedTexts = new Set<string>();
    for (const t of turns) {
      if (t.role !== 'learner') continue;
      for (const tok of segment(t.zh, this.lexicon)) if (tok.kind === 'word') typedTexts.add(tok.text);
    }
    const ctx = { vocab, lexicon: this.lexicon, typedTexts, upcomingIds: vocab.upcomingIds };

    const base: Omit<OpenTurnRequest, 'feedback'> = {
      mode: 'open',
      topic,
      tiers: vocab.tiers,
      ...(conv.summary ? { summary: conv.summary } : {}),
      ...(vocab.grammar.length > 0 ? { grammar: vocab.grammar } : {}),
      ...(vocab.hardTopic ? { hardTopic: true } : {}),
      history: recent.map((t) => ({ role: t.role, zh: t.zh, ...(t.en ? { en: t.en } : {}) })),
      learnerLevel: options.learnerLevel,
      scaffolding: options.scaffolding,
      englishFallback: options.englishFallback,
    };

    const validate = (response: TurnResponse): OpenReport => {
      // Phase 36: up to 2 words kept to keep the meaning are allowed (and glossed)
      const kept = keptWords(response);
      const c = kept.length > 0 ? { ...ctx, typedTexts: new Set([...typedTexts, ...kept]) } : ctx;
      const report = validateOpenChatTurn(response, c, this.config.limits);
      return { ...report, taiwanClean: report.taiwanness.isClean, feedback: openChatFeedback(report, this.config.limits) };
    };

    const ids = (ts: OpenChatReport['tokens'], tier: 'B' | 'C') => [
      ...new Set(ts.filter((t) => t.tier === tier && t.wordId).map((t) => t.wordId!)),
    ];

    const turn: ModeTurn<OpenReport> = {
      generate: (x) =>
        generate({
          ...base,
          ...(x.feedback ? { feedback: x.feedback } : {}),
          ...(x.alternateModel ? { alternateModel: true } : {}),
          ...(x.facts.length > 0 ? { facts: x.facts } : {}),
          ...(x.learnerMeaningEn ? { learnerMeaningEn: x.learnerMeaningEn } : {}),
        }),
      validate,
      pickBest: (attempts) => pickBestOpenChatAttempt(attempts),
      // Same as Phase 3: leaked words enter the learner model as introduced, with their gloss shown.
      leakedWordIds: (report) =>
        report.pass ? [] : [...report.offendersB, ...report.offendersC].flatMap((t) => (t.wordId ? [t.wordId] : [])),
      npcFields: (response, report) => {
        // Gloss tier C always (the topic needed it), and tier B too when the reply broke a limit.
        const glosses = openChatGlosses(
          { offendersB: report.pass ? [] : report.offendersB, offendersC: report.offendersC },
          this.lexicon,
        );
        const upcomingIds = [
          ...new Set(
            report.tokens.filter((t) => t.wordId && vocab.upcomingIds.has(t.wordId)).map((t) => t.wordId!),
          ),
        ];
        return {
          // Phase 21: the sense the model picked is kept (like scenario chat) when it is a real sense of the word.
          tokens: response.tokens.map(({ text, lemma, sense_id }) => {
            const sense = sense_id ? this.lexicon.byId(sense_id) : undefined;
            const ok = !!sense && [sense.headword, ...sense.variants].some((h) => h === (lemma ?? text) || h === text);
            return { text, ...(lemma ? { lemma } : {}), ...(ok ? { sense_id } : {}) };
          }),
          validatorReport: {
            coverage: report.shareA,
            maxLevel: null,
            unknownCount: report.counts.b + report.counts.c,
            attempts: 0,
            pass: report.pass,
            tiers: {
              a: report.counts.a,
              b: report.counts.b,
              c: report.counts.c,
              allowed: report.counts.allowed,
              shareA: report.shareA,
              usesUpcoming: report.usesUpcoming,
              bIds: ids(report.tokens, 'B'),
              cIds: ids(report.tokens, 'C'),
              upcomingIds,
            },
          },
          ...(glosses.length > 0 ? { glosses } : {}),
        };
      },
    };
    return { turn, vocab };
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

  // ---- end summary -------------------------------------------------------------

  async getSummary(conversationId: number): Promise<OpenChatSummary> {
    const [turns, conv] = await Promise.all([
      this.getTurns(conversationId),
      this.db.conversations.get(conversationId) as Promise<ConversationRow | undefined>,
    ]);
    const npc = turns.filter((t) => t.role === 'npc' && t.validatorReport?.tiers);
    const tiers = npc.map((t) => t.validatorReport!.tiers!);
    const mix = openChatTierMix(tiers);

    const lower = conv?.startedAt ?? new Date(0);
    const upper = conv?.endedAt ?? new Date();
    const evidence = await this.db.evidence.where('at').between(lower, upper, true, true).toArray();
    const lookedUp = new Set(
      evidence
        .filter((e) => e.kind === 'chat_lookup_gloss' || e.kind === 'chat_hover_reading')
        .map((e) => e.item.id),
    );

    // Phase 21: "New words you met" lists only words not already Learned.
    const knownIds = (await this.learnerService.ledger(upper)).learnedWordIds();
    const metIds = [...new Set(tiers.flatMap((t) => [...t.bIds, ...t.cIds, ...t.upcomingIds]))].filter(
      (id) => !knownIds.has(id),
    );
    const wordsMet = metIds.flatMap((wordId) => {
      const w = this.lexicon.byId(wordId);
      return w
        ? [{ wordId, headword: w.headword, glossEn: glossFor(w, { textbook: false }), lookedUp: lookedUp.has(wordId) }]
        : [];
    });
    return {
      turnCount: turns.length,
      learnerTurns: turns.filter((t) => t.role === 'learner').length,
      topic: conv?.topic ?? '',
      tierShareA: mix.shareA,
      upcomingTurnShare:
        tiers.length === 0 ? 0 : tiers.filter((t) => t.usesUpcoming).length / tiers.length,
      wordsMet,
      wordsLookedUp: [...lookedUp].flatMap((id) => this.lexicon.byId(id)?.headword ?? []),
    };
  }

  /** "Add to review" for the chosen words: the learner asked for them, so no level gate (Phase 20). */
  async addToReview(wordIds: readonly string[], now: Date = new Date()): Promise<void> {
    for (const id of wordIds) await this.learnerService.restore({ kind: 'word', id }, now);
  }
}
