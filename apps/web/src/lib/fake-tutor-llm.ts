import type { TurnRequest, TurnResponse, TutorLLM } from '@anan/core';

export type FakeTurnScript = (req: TurnRequest, callIndex: number) => TurnResponse;

/** No-network TutorLLM for dev (no API keys configured) and tests. A script
 * function decides each reply; a simple default is provided for quick use. */
export class FakeTutorLLM implements TutorLLM {
  private callIndex = 0;

  constructor(private readonly script: FakeTurnScript = FakeTutorLLM.defaultScript) {}

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
  };

  static defaultScript: FakeTurnScript = (req, callIndex) => {
    const steps = FakeTutorLLM.GOAL_STEPS[req.scenarioId] ?? [];
    return {
      reply_zh: '好的，還需要什麼嗎？',
      reply_en: 'Okay, anything else?',
      tokens: [{ text: '好的' }, { text: '還' }, { text: '需要' }, { text: '什麼' }, { text: '嗎' }],
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
