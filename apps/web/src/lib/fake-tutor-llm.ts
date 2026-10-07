import type {
  DefineRequest,
  DefineResponse,
  JournalCheckRequest,
  JournalCheckResponse,
  JournalExplainRequest,
  JournalExplainResponse,
  JournalReview,
  JournalReviewRequest,
  JournalSentenceFixRequest,
  JournalSolveRequest,
  JournalSolveResponse,
  JournalVerifyRequest,
  JournalVerifyResponse,
  ModelSentenceReview,
  OpenTurnRequest,
  SentenceGenRequest,
  SentenceGenResponse,
  TopicWordsRequest,
  TopicWordsResponse,
  TurnRequest,
  TurnResponse,
  TutorLLM,
} from '@anan/core';

export type FakeSentenceScript = (req: SentenceGenRequest) => SentenceGenResponse;

export type FakeOpenScript = (req: OpenTurnRequest, callIndex: number) => TurnResponse;

export type FakeTurnScript = (req: TurnRequest, callIndex: number) => TurnResponse;

/** Optional overrides for the journal half of the fake; anything omitted uses
 * the deterministic defaults below. */
export interface FakeJournalScript {
  review?: (req: JournalReviewRequest) => JournalReview;
  check?: (req: JournalCheckRequest) => JournalCheckResponse;
  explain?: (req: JournalExplainRequest) => JournalExplainResponse;
  clozeCheck?: (req: { sentence: string }) => { ok: boolean; reason?: string };
  fixSentence?: (req: JournalSentenceFixRequest) => ModelSentenceReview;
  verify?: (req: JournalVerifyRequest) => JournalVerifyResponse;
  solve?: (req: JournalSolveRequest) => JournalSolveResponse;
}

/** No-network TutorLLM for dev (no API keys configured) and tests. A script
 * function decides each reply; a simple default is provided for quick use. */
export class FakeTutorLLM implements TutorLLM {
  private callIndex = 0;

  constructor(
    private readonly script: FakeTurnScript = FakeTutorLLM.defaultScript,
    private readonly journal: FakeJournalScript = {},
    private readonly sentences: FakeSentenceScript = FakeTutorLLM.defaultSentences,
    private readonly openScript: FakeOpenScript = FakeTutorLLM.defaultOpenScript,
    private readonly topicWords: (req: TopicWordsRequest) => string[] = () => ['吃', '飯', '喝', '咖啡'],
  ) {}

  /** Phase 18 calls, for "was the LLM asked?" assertions. */
  readonly openCalls: OpenTurnRequest[] = [];
  topicWordCalls = 0;

  async generateOpenTurn(req: OpenTurnRequest): Promise<TurnResponse> {
    const response = this.openScript(req, this.openCalls.length);
    this.openCalls.push(req);
    return response;
  }

  async generateTopicWords(req: TopicWordsRequest): Promise<TopicWordsResponse> {
    this.topicWordCalls++;
    return { words: this.topicWords(req) };
  }

  static defaultOpenScript: FakeOpenScript = (req) => ({
    reply_zh: req.topic ? '好啊！你喜歡吃什麼？' : '你今天做了什麼？',
    reply_en: req.topic ? 'Sure! What do you like to eat?' : 'What did you do today?',
    tokens: [],
    targets_used: [],
    suggested_replies: [
      { zh: '我喜歡吃飯。', en: 'I like rice.' },
      { zh: '我不知道。', en: "I don't know." },
    ],
    goal_progress: [],
  });

  /** Calls to generateSentences, for "was the LLM asked?" assertions. */
  sentenceCalls = 0;

  async generateSentences(req: SentenceGenRequest): Promise<SentenceGenResponse> {
    this.sentenceCalls++;
    return this.sentences(req);
  }

  /** Dev/e2e default: simple sentences around the focus word. */
  static defaultSentences: FakeSentenceScript = (req) => ({
    sentences: [`我們去${req.word.headword}。`, `你喜歡${req.word.headword}嗎？`].map((zh) => ({
      zh,
      en: `fake sentence about ${req.word.glossEn}`,
      tokens: [],
    })),
  });

  /** Calls recorded for tests ("was the LLM asked?"). */
  readonly journalCalls = { review: 0, check: 0, explain: 0 };

  async reviewJournal(req: JournalReviewRequest): Promise<JournalReview> {
    this.journalCalls.review++;
    return (this.journal.review ?? FakeTutorLLM.defaultJournalReview)(req);
  }

  /** Phase 17: no-network defaults. The checker passes everything; the solver
   * can't see the answer, so it is never confident (blanks it can't decide are
   * dropped, as the real flow would). */
  async fixJournalSentence(
    req: JournalSentenceFixRequest,
  ): Promise<{ review: ModelSentenceReview; servedBy?: 'gemini' | 'openai' }> {
    const review = this.journal.fixSentence?.(req);
    if (!review) throw new Error('no fix scripted');
    return { review, servedBy: 'gemini' };
  }

  async verifyJournalSentence(req: JournalVerifyRequest): Promise<JournalVerifyResponse> {
    return (this.journal.verify ?? (() => ({ ok: true, problem: '', meaningMatches: true })))(req);
  }

  async solveJournalCloze(req: JournalSolveRequest): Promise<JournalSolveResponse> {
    return (this.journal.solve ?? (() => ({ answers: [], confident: false })))(req);
  }

  /** Phase 16: the naturalness check. Passes everything unless scripted. */
  async checkCloze(req: { sentence: string }): Promise<{ ok: boolean; reason?: string }> {
    return (this.journal.clozeCheck ?? (() => ({ ok: true })))(req);
  }

  async defineWord(req: DefineRequest): Promise<DefineResponse> {
    return { pinyin: 'xīn cí', glossEn: `fake definition of ${req.word}` };
  }

  async checkJournalFix(req: JournalCheckRequest): Promise<JournalCheckResponse> {
    this.journalCalls.check++;
    return (this.journal.check ?? FakeTutorLLM.defaultJournalCheck)(req);
  }

  async explainJournalIssue(req: JournalExplainRequest): Promise<JournalExplainResponse> {
    this.journalCalls.explain++;
    return (this.journal.explain ?? FakeTutorLLM.defaultJournalExplain)(req);
  }

  /** Dev/e2e default: flags 地鐵 as mainland style (→ 捷運), translates a
   * `[gym]` gap, and otherwise finds nothing wrong. */
  static defaultJournalReview = (req: JournalReviewRequest): JournalReview => {
    const issues: JournalReview['issues'] = [];
    const subway = req.text.indexOf('地鐵');
    if (subway !== -1) {
      issues.push({
        span: [subway, subway + 2],
        type: 'mainland_style',
        pattern: 'mainland-vocab',
        correction: '捷運',
        explanationEn: 'In Taiwan the metro is usually called 捷運.',
        confidence: 'high',
      });
    }
    return {
      issues,
      natural_rewrite: req.text.replace('地鐵', '捷運').replace('[gym]', '健身房'),
      brackets: req.text.includes('[gym]') ? [{ en: 'gym', zh: '健身房' }] : [],
      used_well: [],
      // Phase 17: every numbered sentence, fixed the same way as the issue above.
      sentences: (req.sentences ?? []).map((zh, index) => {
        const corrected = zh.replace('地鐵', '捷運');
        return {
          index,
          corrected,
          en: 'A sentence.',
          edits:
            corrected === zh
              ? []
              : [
                  {
                    before: '地鐵',
                    after: '捷運',
                    contextBefore: zh.slice(Math.max(0, zh.indexOf('地鐵') - 2), zh.indexOf('地鐵')),
                    kind: 'mainland_style' as const,
                    pattern: 'mainland-vocab',
                    explanationEn: 'In Taiwan the metro is usually called 捷運.',
                  },
                ],
        };
      }),
    };
  };

  static defaultJournalCheck = (req: JournalCheckRequest): JournalCheckResponse =>
    req.attempt === req.correction
      ? { acceptable: true, noteEn: 'That works.' }
      : { acceptable: false, noteEn: 'Still not quite natural.' };

  static defaultJournalExplain = (req: JournalExplainRequest): JournalExplainResponse => ({
    explanationEn: `${req.explanationEn} (More detail: Taiwanese speakers usually prefer this wording.)`,
    examples: [{ zh: '我搭捷運。', en: 'I take the MRT.' }],
  });

  async generateTurn(req: TurnRequest): Promise<TurnResponse> {
    const response = this.script(req, this.callIndex);
    this.callIndex++;
    return response;
  }

  // Mirrors data/scenarios/*.yaml's goalSteps ids, so the dev-only "fake
  // tutor" toggle (no API key needed) can demonstrate a full
  // scenario-complete + summary flow without a real LLM. A TurnRequest only
  // carries a scenarioId (the proxy resolves the rest server-side), so the
  // fake has to know this out of band — kept here rather than in core,
  // since it's test/dev-only data, not part of the real contract.
  private static readonly GOAL_STEPS: Record<string, string[]> = {
    'tea-shop': ['order-drink', 'specify-ice', 'specify-sugar', 'size-and-takeaway', 'pay'],
    'easycard-topup': ['state-need', 'specify-amount', 'payment-method', 'confirm-done'],
    'convenience-store': ['greet-and-total', 'bag', 'payment-method', 'receipt'],
    'night-market': ['choose-food', 'ask-spicy', 'ask-price', 'pay-and-thank'],
    'clinic-call': ['say-reason', 'choose-time', 'give-name', 'confirm-bring'],
    youbike: ['ask-how', 'use-card', 'ask-return', 'ask-cost'],
    'landlord-deposit': ['ask-rent', 'ask-deposit', 'ask-return', 'ask-bills'],
  };

  static defaultScript: FakeTurnScript = (req, callIndex) => {
    const steps = FakeTutorLLM.GOAL_STEPS[req.scenarioId] ?? [];
    return {
      reply_zh: '好的，還需要什麼嗎？',
      reply_en: 'Okay, anything else?',
      tokens: [
        { text: '好的' },
        { text: '還' },
        { text: '需要' },
        { text: '什麼' },
        { text: '嗎' },
      ],
      targets_used: req.vocab.targets.slice(0, 1),
      suggested_replies: [
        { zh: '沒有了，謝謝', en: "No, that's all, thanks" },
        { zh: '多少錢？', en: 'How much is it?' },
      ],
      // All steps "done" from the 3rd learner turn onward (each turn can
      // burn up to 1 + maxRegenerations calls when every attempt fails
      // validation, as happens with a fresh, empty learner model) — enough
      // to demo the complete + summary flow without modeling real progress.
      goal_progress: steps.map((step) => ({ step, done: callIndex >= 6 })),
    };
  };
}
