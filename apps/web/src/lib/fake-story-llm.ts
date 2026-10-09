import {
  dryStory,
  dryStoryCheck,
  dryStoryRepair,
  type ProviderName,
  type StoryRepairRequest,
  type StoryRepairResponse,
  type StoryCheckRequest,
  type StoryCheckResponse,
  type StoryLLM,
  type StoryRequest,
  type StoryResponse,
} from '@anan/core';

export type FakeStoryScript = (req: StoryRequest, callIndex: number) => StoryResponse;

/**
 * Phase 24: a no-network story writer for dev (no API keys) and tests. The default story is
 * built only from the request's own word lists (rung 1, each rung 2 word twice, one rung 3 word),
 * one word per comma, so it always meets the shares; the checker agrees with every answer.
 */
export class FakeStoryLLM implements StoryLLM {
  readonly writeCalls: StoryRequest[] = [];
  readonly checkCalls: StoryCheckRequest[] = [];
  readonly repairCalls: StoryRepairRequest[] = [];

  constructor(
    private readonly script: FakeStoryScript = FakeStoryLLM.defaultStory,
    private readonly check: (req: StoryCheckRequest) => StoryCheckResponse = FakeStoryLLM.defaultCheck,
    private readonly servedBy: ProviderName = 'gemini',
    private readonly repair: (req: StoryRepairRequest) => StoryRepairResponse = dryStoryRepair,
  ) {}

  async repairStory(req: StoryRepairRequest): Promise<StoryRepairResponse> {
    this.repairCalls.push(req);
    return this.repair(req);
  }

  async writeStory(req: StoryRequest): Promise<{ story: StoryResponse; servedBy?: ProviderName }> {
    this.writeCalls.push(req);
    return { story: this.script(req, this.writeCalls.length - 1), servedBy: this.servedBy };
  }

  async checkStory(req: StoryCheckRequest): Promise<StoryCheckResponse> {
    this.checkCalls.push(req);
    return this.check(req);
  }

  static defaultCheck(req: StoryCheckRequest): StoryCheckResponse {
    return dryStoryCheck(req);
  }

  static defaultStory(req: StoryRequest): StoryResponse {
    return dryStory(req);
  }
}
