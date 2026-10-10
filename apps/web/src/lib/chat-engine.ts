// Phase 36: one chat engine. Scenario chat and open chat (wherever they are opened from: Home,
// Chats, a lesson step) run every turn through this pipeline. A mode only supplies how a reply is
// asked for (persona, scene and goal steps, or a topic) and its word-budget check; everything else
// is here, once: the learner's message and its "Read as", the facts list, the meaning check
// (core's runChatTurn), gentle corrections by the journal corrector, gap fills, the
// "Words from this chat" panel and its "Add to review".
import {
  CHAT_LEAK_REF,
  checkTaiwanness,
  extractBrackets,
  glossFor,
  keptWords,
  mergeFacts,
  runChatTurn,
  segment,
  type ChatTurnValidation,
  type Evidence,
  type Level,
  type Lexicon,
  type TurnResponse,
  type TutorLLM,
  type Word,
} from '@anan/core';
import type { AnanDB, ConversationRow, TurnRow } from '../db/schema.js';
import { chainShortNow } from './ai-quota.js';
import { JournalService } from './journal-service.js';
import type { LearnerService } from './learner-service.js';
import { isQuotaError } from './tutor-llm.js';

/** Phase 21 Part J: a reply that still fails the Taiwan / traditional check after every retry. */
export class UnreliableReplyError extends Error {
  constructor() {
    super("Couldn't get a reliable reply, try again");
    this.name = 'UnreliableReplyError';
  }
}

/** Phase 21 Part J: suggested replies, recasts and "Try:" lines are shown only when they pass the
 * Taiwan / traditional-characters check; failing ones are dropped. */
export const isCleanChinese = (zh: string | undefined): zh is string => !!zh && checkTaiwanness(zh).isClean;

export interface ChatTurnOptions {
  learnerLevel: Level;
  scaffolding: 'high' | 'medium' | 'low';
  englishFallback: boolean;
  /** Settings → Chat → Show corrections (per profile, on by default in the app). */
  showCorrections?: boolean;
}

/** One reply request in a mode, built fresh for each reply. */
export interface ModeTurn<R extends ChatTurnValidation> {
  generate(extra: {
    feedback?: string;
    alternateModel?: boolean;
    facts: string[];
    learnerMeaningEn?: string;
  }): Promise<TurnResponse>;
  validate(response: TurnResponse): R;
  pickBest?(attempts: ReadonlyArray<{ response: TurnResponse; report: R }>): { response: TurnResponse; report: R };
  /** The stored reply's mode-specific fields (tokens, validator report, glosses). */
  npcFields(response: TurnResponse, report: R): Partial<TurnRow>;
  /** Words the reply leaked past the budget: they enter the learner model as introduced (Phase 3). */
  leakedWordIds(report: R): string[];
  /** After the reply is stored (scenario goal steps). */
  after?(npcTurn: TurnRow, response: TurnResponse): Promise<void>;
}

export interface ChatMode<R extends ChatTurnValidation> {
  prepare(conversationId: number, turns: TurnRow[], options: ChatTurnOptions, now: Date): Promise<ModeTurn<R>>;
  /** After the learner's message is stored (open chat marks the day active, Phase 32). */
  onLearnerTurn?(now: Date): Promise<void>;
}

export interface ChatEngineDeps {
  db: AnanDB;
  lexicon: Lexicon;
  learnerService: LearnerService;
  tutorLLM: TutorLLM;
  maxRegenerations: number;
  /** The journal corrector (Phase 31). Built from the above when absent. */
  journal?: JournalService;
  /** Is the journal chain short of free quota (corrections pause)? Default: GET /v1/ai-usage. */
  quotaShort?: () => Promise<boolean>;
}

export interface ChatReplyResult<R> {
  npcTurn: TurnRow;
  report: R;
  attempts: number;
  misunderstood: boolean;
}

export interface ChatSendResult<R> extends ChatReplyResult<R> {
  learnerTurn: TurnRow;
  /** Settles when the message's correction and gap fills are stored (the page refreshes then). */
  corrections: Promise<void>;
}

export type ChatWordSource = 'gap' | 'lookup' | 'glossed' | 'corrected';

/** One line of "Words from this chat". */
export interface ChatWordEntry {
  key: string;
  zh: string;
  pinyin: string;
  glossEn: string;
  wordId?: string;
  /** A gap option with no lexicon entry (added as a custom word). */
  gap?: { turnId: number; en: string; zh: string };
  sources: ChatWordSource[];
  inReview: boolean;
}

/** Chinese characters: only messages with some Chinese get a correction. */
const HAN = /\p{Script=Han}/u;

/** The facts the learner stated in these turns, merged in order. */
export function factsOf(turns: readonly TurnRow[]): string[] {
  return turns.reduce<string[]>((acc, t) => (t.role === 'learner' && t.facts?.length ? mergeFacts(acc, t.facts) : acc), []);
}

export class ChatEngine {
  readonly journal: JournalService;
  private readonly quotaShort: () => Promise<boolean>;

  constructor(private readonly deps: ChatEngineDeps) {
    this.journal = deps.journal ?? new JournalService(deps.db, deps.lexicon, deps.learnerService, deps.tutorLLM);
    this.quotaShort = deps.quotaShort ?? (() => chainShortNow('journal'));
  }

  /** The conversation as shown: in order, replaced replies left out. */
  async visibleTurns(conversationId: number): Promise<TurnRow[]> {
    const all = await this.deps.db.turns.where('conversationId').equals(conversationId).sortBy('id');
    return all.filter((t) => !t.replaced);
  }

  async facts(conversationId: number): Promise<string[]> {
    return factsOf(await this.visibleTurns(conversationId));
  }

  private async conversationRef(conversationId: number): Promise<string> {
    const conv = (await this.deps.db.conversations.get(conversationId)) as ConversationRow | undefined;
    return conv?.uid ?? String(conversationId);
  }

  // ---- one turn ---------------------------------------------------------------------------------

  /** The learner's message: stored, corrected in parallel (on the journal chain), and answered. */
  async send<R extends ChatTurnValidation>(
    conversationId: number,
    mode: ChatMode<R>,
    text: string,
    options: ChatTurnOptions,
    now: Date = new Date(),
  ): Promise<ChatSendResult<R>> {
    const { db } = this.deps;
    // the previous messages' corrections are final now: they reach the error bank (Phase 31 Part E)
    void this.finishCorrections(conversationId, now).catch(() => undefined);
    const before = await this.visibleTurns(conversationId);
    const learnerId = (await db.turns.add({ conversationId, role: 'learner', zh: text, at: now })) as number;
    await mode.onLearnerTurn?.(now);
    if (options.englishFallback) await db.conversations.update(conversationId, { englishFallbackUsed: true });
    const learnerTurn = (await db.turns.get(learnerId))!;
    const corrections = this.correct(learnerTurn, before, options).catch(() => undefined);
    const result = await this.reply(conversationId, mode, options, now);
    return { ...result, learnerTurn: (await db.turns.get(learnerId))!, corrections };
  }

  /** Answers the last learner message (also for "Try again" and a fixed meaning). */
  async reply<R extends ChatTurnValidation>(
    conversationId: number,
    mode: ChatMode<R>,
    options: ChatTurnOptions,
    now: Date = new Date(),
  ): Promise<ChatReplyResult<R>> {
    const { db, lexicon, learnerService, tutorLLM } = this.deps;
    const turns = await this.visibleTurns(conversationId);
    const learner = turns[turns.length - 1];
    if (!learner || learner.role !== 'learner') throw new Error('Nothing to answer.');
    const factsBefore = factsOf(turns.slice(0, -1));
    const learnerMeaningEn = learner.meaningFixed ? learner.meaningEn : undefined;
    const turn = await mode.prepare(conversationId, turns, options, now);

    const result = await runChatTurn<R>({
      generate: (x) => turn.generate({ ...x, facts: factsBefore, ...(learnerMeaningEn ? { learnerMeaningEn } : {}) }),
      validate: (r) => turn.validate(r),
      ...(turn.pickBest ? { pickBest: (a) => turn.pickBest!(a) } : {}),
      ...(tutorLLM.checkChatMeaning ? { checkMeaning: (r) => tutorLLM.checkChatMeaning!(r) } : {}),
      facts: factsBefore,
      learnerMessage: learner.zh,
      maxRegenerations: this.deps.maxRegenerations,
      unreliable: () => new UnreliableReplyError(),
    });
    const { response, report } = result;

    const leaked = turn.leakedWordIds(report);
    if (leaked.length > 0) {
      // Phase 3: leaked words enter the learner model as introduced, with their gloss shown.
      const events: Evidence[] = [...new Set(leaked)].map((id) => ({
        item: { kind: 'word', id },
        skill: 'recognition',
        kind: 'chat_lookup_gloss',
        at: now,
        context: { source: 'chat', refId: CHAT_LEAK_REF },
      }));
      await learnerService.recordBulk(events, now);
    }

    const fields = turn.npcFields(response, report);
    if (fields.validatorReport) fields.validatorReport = { ...fields.validatorReport, attempts: result.attempts };
    // words kept outside the budget to keep the meaning are glossed (never auto-added)
    const kept = keptWords(response).flatMap((text) => {
      const w = lexicon.lookup(text)[0];
      return w && !(fields.glosses ?? []).some((g) => g.text === text) ? [{ text, gloss: glossFor(w) }] : [];
    });
    const glosses = [...(fields.glosses ?? []), ...kept];
    const meaning = response.learner_meaning_en?.trim();
    await db.turns.update(learner.id!, {
      ...(meaning && !learner.meaningFixed ? { meaningEn: meaning } : {}),
      facts: result.turnFacts,
    });
    const npcId = (await db.turns.add({
      conversationId,
      role: 'npc',
      zh: response.reply_zh,
      en: response.reply_en,
      suggestedReplies: response.suggested_replies.filter((r) => isCleanChinese(r.zh)),
      ...(isCleanChinese(response.recast_zh) ? { recastZh: response.recast_zh } : {}),
      ...fields,
      ...(glosses.length > 0 ? { glosses } : {}),
      ...(result.misunderstood ? { misunderstood: true } : {}),
      at: now,
    })) as number;
    const npcTurn = (await db.turns.get(npcId))!;
    await turn.after?.(npcTurn, response);
    return { npcTurn, report, attempts: result.attempts, misunderstood: result.misunderstood };
  }

  /** "⚠ This reply may have misunderstood you" → Try again: the reply is replaced. */
  async tryAgain<R extends ChatTurnValidation>(
    conversationId: number,
    mode: ChatMode<R>,
    options: ChatTurnOptions,
    now: Date = new Date(),
  ): Promise<ChatReplyResult<R>> {
    await this.replaceRepliesAfterLastLearner(conversationId);
    return this.reply(conversationId, mode, options, now);
  }

  /**
   * "What did you mean?" on the learner's last message: their meaning replaces the "Read as", the
   * reply is regenerated aiming at it, and the correction is checked again with it.
   */
  async fixMeaning<R extends ChatTurnValidation>(
    conversationId: number,
    learnerTurnId: number,
    meaningEn: string,
    mode: ChatMode<R>,
    options: ChatTurnOptions,
    now: Date = new Date(),
  ): Promise<ChatReplyResult<R> & { corrections: Promise<void> }> {
    const en = meaningEn.trim().slice(0, 300);
    if (!en) throw new Error('Say what you meant first.');
    const turns = await this.visibleTurns(conversationId);
    const lastLearner = [...turns].reverse().find((t) => t.role === 'learner');
    if (!lastLearner || lastLearner.id !== learnerTurnId) throw new Error('Only your last message can be fixed.');
    await this.deps.db.turns.update(learnerTurnId, { meaningEn: en, meaningFixed: true, facts: [] });
    await this.replaceRepliesAfterLastLearner(conversationId);
    const entryId = lastLearner.correction?.entryId;
    const corrections = entryId
      ? this.journal
          .setMeaning(entryId, en)
          .then(async () => {
            const review = await this.journal.getReview(entryId);
            await this.deps.db.turns.update(learnerTurnId, {
              correction: { status: review && review.issues.length > 0 ? 'issues' : 'clean', entryId },
            });
          })
          .catch(() => undefined)
      : Promise.resolve();
    const result = await this.reply(conversationId, mode, options, now);
    return { ...result, corrections };
  }

  private async replaceRepliesAfterLastLearner(conversationId: number): Promise<void> {
    const turns = await this.visibleTurns(conversationId);
    let i = turns.length - 1;
    while (i >= 0 && turns[i]!.role === 'npc') {
      await this.deps.db.turns.update(turns[i]!.id!, { replaced: true });
      i--;
    }
  }

  // ---- corrections and gaps (Parts C and D) -------------------------------------------------------

  private async correct(learner: TurnRow, before: readonly TurnRow[], options: ChatTurnOptions): Promise<void> {
    const { db } = this.deps;
    const id = learner.id!;
    const text = learner.zh;
    const show = options.showCorrections === true;
    const hasGaps = extractBrackets(text).length > 0;
    const hasHan = HAN.test(text);
    const short = show || hasGaps ? await this.quotaShort().catch(() => false) : false;
    const tasks: Promise<unknown>[] = [];
    if (hasGaps)
      tasks.push(
        this.journal
          .fillGaps(text, options.learnerLevel, { useModel: !short })
          .then((gaps) => db.turns.update(id, { gaps }))
          .catch(() => undefined),
      );
    if (hasHan) {
      if (!show) await db.turns.update(id, { correction: { status: 'off' } });
      else if (short) await db.turns.update(id, { correction: { status: 'paused' } });
      else {
        await db.turns.update(id, { correction: { status: 'pending' } });
        tasks.push(this.runCorrector(learner, before, options));
      }
    }
    await Promise.all(tasks);
  }

  private async runCorrector(learner: TurnRow, before: readonly TurnRow[], options: ChatTurnOptions): Promise<void> {
    const { db } = this.deps;
    const id = learner.id!;
    try {
      const { entry, review } = await this.journal.submit({
        text: learner.zh,
        learnerLevel: options.learnerLevel,
        source: 'chat',
        conversationRef: await this.conversationRef(learner.conversationId),
        chatContext: before.slice(-12).map((t) => ({ role: t.role, zh: t.zh })),
        skipBrackets: true,
      });
      // corrections in chat are shown at once (there is no self-correct step)
      await this.journal.reveal(entry.id);
      await db.turns.update(id, { correction: { status: review.issues.length > 0 ? 'issues' : 'clean', entryId: entry.id } });
    } catch (err) {
      await db.turns.update(id, { correction: { status: isQuotaError(err) ? 'paused' : 'failed' } });
    }
  }

  /** The conversation's corrections become final: error-bank items and evidence, as a finished
   * journal entry (Phase 31 Part E). Runs when the next message is sent and when the chat ends. */
  async finishCorrections(conversationId: number, now: Date = new Date()): Promise<void> {
    const ref = await this.conversationRef(conversationId);
    const open = await this.deps.db.journalEntries
      .filter((e) => e.source === 'chat' && e.conversationRef === ref && e.status !== 'finished')
      .toArray();
    for (const e of open) await this.journal.finish(e.id, now).catch(() => undefined);
  }

  /** Chats left open (closed tab, no "End chat") are finished after an hour. */
  async finishStaleCorrections(now: Date = new Date()): Promise<void> {
    const cutoff = now.getTime() - 3_600_000;
    const open = await this.deps.db.journalEntries
      .filter((e) => e.source === 'chat' && e.status !== 'finished' && e.createdAt.getTime() < cutoff)
      .toArray();
    for (const e of open) await this.journal.finish(e.id, now).catch(() => undefined);
  }

  /** "Add to review" on one gap option of a chat message (nothing is added without a tap). */
  async addGapWord(turnId: number, en: string, zh: string, now: Date = new Date()): Promise<void> {
    const turn = await this.deps.db.turns.get(turnId);
    const gap = turn?.gaps?.find((g) => g.en === en);
    const option = gap?.options?.find((o) => o.zh === zh);
    if (!turn || !gap || !option) throw new Error('Unknown gap option.');
    if (gap.added?.includes(zh)) return;
    await this.journal.addGapOption(option, en, now);
    const fresh = (await this.deps.db.turns.get(turnId)) ?? turn;
    await this.deps.db.turns.update(turnId, {
      gaps: (fresh.gaps ?? []).map((g) => (g.en === en ? { ...g, added: [...(g.added ?? []), zh] } : g)),
    });
  }

  // ---- "Words from this chat" (Part D.2) ----------------------------------------------------------

  async wordPanel(conversationId: number, now: Date = new Date()): Promise<ChatWordEntry[]> {
    const { db, lexicon, learnerService } = this.deps;
    const [turns, conv] = await Promise.all([
      this.visibleTurns(conversationId),
      db.conversations.get(conversationId) as Promise<ConversationRow | undefined>,
    ]);
    const entries = new Map<string, ChatWordEntry>();
    const addWord = (w: Word, source: ChatWordSource) => {
      const e = entries.get(w.id) ?? {
        key: w.id,
        zh: w.headword,
        pinyin: w.pinyin,
        glossEn: glossFor(w, { textbook: false }),
        wordId: w.id,
        sources: [],
        inReview: false,
      };
      if (!e.sources.includes(source)) e.sources.push(source);
      entries.set(w.id, e);
    };

    for (const t of turns) {
      if (t.role === 'learner') {
        for (const g of t.gaps ?? [])
          for (const o of g.options ?? []) {
            const w = (o.wordId ? lexicon.byId(o.wordId) : undefined) ?? lexicon.lookup(o.zh)[0];
            if (w) {
              addWord(w, 'gap');
              if (g.added?.includes(o.zh)) entries.get(w.id)!.inReview = true;
            } else {
              const key = `gap:${o.zh}`;
              entries.set(key, {
                key,
                zh: o.zh,
                pinyin: o.pinyin,
                glossEn: o.meaningEn || g.en,
                gap: { turnId: t.id!, en: g.en, zh: o.zh },
                sources: ['gap'],
                inReview: g.added?.includes(o.zh) ?? false,
              });
            }
          }
      } else {
        for (const g of t.glosses ?? []) {
          const w = lexicon.lookup(g.text)[0];
          if (w) addWord(w, 'glossed');
        }
      }
    }

    // corrected words: what the corrector put in place of the learner's words (含 → 和)
    for (const t of turns) {
      const entryId = t.role === 'learner' ? t.correction?.entryId : undefined;
      if (!entryId) continue;
      const [entry, review] = await Promise.all([this.journal.getEntry(entryId), this.journal.getReview(entryId)]);
      if (!entry || !review) continue;
      review.issues.forEach((issue, i) => {
        if (review.disputes?.[i]?.verdict === 'upheld') return;
        if (issue.itemRef?.kind === 'word') {
          const w = lexicon.byId(issue.itemRef.id);
          if (w) return addWord(w, 'corrected');
        }
        const original = entry.text.slice(issue.span[0], issue.span[1]);
        for (const tok of segment(issue.correction, lexicon)) {
          if (tok.kind !== 'word' || original.includes(tok.text)) continue;
          const w = lexicon.lookup(tok.text)[0];
          if (w) addWord(w, 'corrected');
        }
      });
    }

    // words looked up while this chat was open
    const lower = conv?.startedAt ?? new Date(0);
    const upper = conv?.endedAt ?? now;
    const lookups = await db.evidence.where('at').between(lower, upper, true, true).toArray();
    for (const e of lookups) {
      if (e.item.kind !== 'word') continue;
      if (e.kind !== 'chat_lookup_gloss' && e.kind !== 'chat_hover_reading') continue;
      if (e.context?.refId === CHAT_LEAK_REF) continue;
      const w = lexicon.byId(e.item.id);
      if (w) addWord(w, 'lookup');
    }

    // Phase 29: "in review" comes from the ledger (a card that isn't removed)
    const ledger = await learnerService.ledger(now);
    for (const e of entries.values()) {
      if (!e.wordId) continue;
      const ref = { kind: 'word' as const, id: e.wordId };
      e.inReview ||= ledger.hasCard(ref) && !ledger.removed(ref);
    }
    return [...entries.values()];
  }

  /** "Add to review" for the ticked words: the learner asked for them, so no level gate (Phase 20). */
  async addToReview(chosen: readonly ChatWordEntry[], now: Date = new Date()): Promise<void> {
    for (const e of chosen) {
      if (e.wordId) await this.deps.learnerService.restore({ kind: 'word', id: e.wordId }, now);
      else if (e.gap) await this.addGapWord(e.gap.turnId, e.gap.en, e.gap.zh, now);
    }
  }
}
