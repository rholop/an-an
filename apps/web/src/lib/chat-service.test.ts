import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lexicon, type Scenario, type TurnResponse, type Word } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { ChatService } from './chat-service.js';
import { FakeTutorLLM } from './fake-tutor-llm.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let learnerService: LearnerService;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});

afterEach(async () => {
  await db.delete();
});

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

const KNOWN_WORDS = ['好的', '還', '需要', '什麼', '沒有', '了', '謝謝'].map((hw, i) => word({ id: `k${i}`, headword: hw }));
const PARTICLE = word({ id: 'p1', headword: '嗎', tags: ['particle'] });
const DUE_WORD = word({ id: 'due1', headword: '錢', level: 'N2' });
const TARGET_CANDIDATE = word({ id: 'target1', headword: '少冰', level: 'N2', freqRank: 1 });
const SCENARIO_EXTRA = word({ id: 'extra1', headword: '珍珠奶茶', level: null, source: 'supplement' });
const OUT_OF_LEVEL = word({ id: 'ool1', headword: '貓', level: 'L5' });

const lexicon = new Lexicon([...KNOWN_WORDS, PARTICLE, DUE_WORD, TARGET_CANDIDATE, SCENARIO_EXTRA, OUT_OF_LEVEL]);

const scenario: Scenario = {
  id: 'tea-shop',
  title: 'Ordering a drink',
  levelRange: { min: 'N1', max: 'L2' },
  npc: { id: 'clerk', name: '店員', personality: 'friendly', speechStyle: 'short', particles: [] },
  setting: 'A counter.',
  goalSteps: [{ id: 'pay', description: 'Pay', keywordHints: [] }],
  vocabExtras: ['珍珠奶茶'],
  opener: { zh: '歡迎光臨！', en: 'Welcome!' },
  successLine: { zh: '謝謝！', en: 'Thanks!' },
};

async function seedKnownAndDue() {
  const now = new Date('2026-01-01');
  const past = new Date(now.getTime() - 86_400_000);
  await learnerService.recordBulk(
    KNOWN_WORDS.map((w) => ({ item: { kind: 'word' as const, id: w.id }, skill: 'recognition' as const, kind: 'anki_import_seen' as const, at: now })),
    now,
  );
  await learnerService.recordBulk(
    [{ item: { kind: 'word' as const, id: DUE_WORD.id }, skill: 'recognition' as const, kind: 'anki_import_seen' as const, at: past }],
    past,
  );
}

const cleanResponse: TurnResponse = {
  reply_zh: '好的，還需要什麼嗎？',
  reply_en: 'Okay, anything else?',
  tokens: [{ text: '好的' }, { text: '還' }, { text: '需要' }, { text: '什麼' }, { text: '嗎' }],
  targets_used: [],
  suggested_replies: [{ zh: '沒有了，謝謝', en: "No, thanks" }],
  goal_progress: [{ step: 'pay', done: false }],
};

const dirtyResponse: TurnResponse = {
  reply_zh: '這隻貓很可愛。',
  reply_en: 'This cat is cute.',
  tokens: [{ text: '這隻貓很可愛' }],
  targets_used: [],
  suggested_replies: [],
  goal_progress: [],
};

describe('ChatService.startConversation', () => {
  it('persists the scenario opener as the first NPC turn without calling the LLM', async () => {
    let calls = 0;
    const llm = new FakeTutorLLM(() => {
      calls++;
      return cleanResponse;
    });
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);

    const turns = await chat.getTurns(conversationId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'npc', zh: scenario.opener.zh });
    expect(calls).toBe(0);
  });
});

describe('ChatService.sendLearnerTurn', () => {
  it('passes validation on the first attempt for a clean, in-budget reply', async () => {
    await seedKnownAndDue();
    const llm = new FakeTutorLLM(() => cleanResponse);
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);

    const result = await chat.sendLearnerTurn(conversationId, scenario, '我要一杯珍珠奶茶', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    expect(result.attempts).toBe(1);
    expect(result.report.pass).toBe(true);
    expect(result.npcTurn.zh).toBe(cleanResponse.reply_zh);
    expect(result.npcTurn.validatorReport?.pass).toBe(true);
  });

  it('persists the learner turn before the NPC turn', async () => {
    await seedKnownAndDue();
    const llm = new FakeTutorLLM(() => cleanResponse);
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);
    await chat.sendLearnerTurn(conversationId, scenario, '我要一杯珍珠奶茶', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    const turns = await chat.getTurns(conversationId);
    expect(turns.map((t) => t.role)).toEqual(['npc', 'learner', 'npc']);
  });

  it('regenerates with feedback on a failing reply, then accepts a later passing one', async () => {
    await seedKnownAndDue();
    let callCount = 0;
    const llm = new FakeTutorLLM((req) => {
      callCount++;
      if (callCount === 1) {
        expect(req.feedback).toBeUndefined();
        return dirtyResponse;
      }
      expect(req.feedback).toBeDefined(); // regeneration includes feedback
      return cleanResponse;
    });
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);

    const result = await chat.sendLearnerTurn(conversationId, scenario, '...', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    expect(callCount).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.report.pass).toBe(true);
    expect(result.npcTurn.zh).toBe(cleanResponse.reply_zh);
  });

  it('after exhausting regenerations, accepts the best attempt and introduces the leaked words', async () => {
    await seedKnownAndDue();
    const llm = new FakeTutorLLM(() => dirtyResponse); // always fails
    const chat = new ChatService(db, lexicon, learnerService, llm, { ...chatConfigFor(), maxRegenerations: 2 });
    const conversationId = await chat.startConversation(scenario);

    const result = await chat.sendLearnerTurn(conversationId, scenario, '...', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    expect(result.attempts).toBe(3); // 1 original + 2 regenerations
    expect(result.report.pass).toBe(false);
    expect(result.npcTurn.validatorReport?.pass).toBe(false);

    // 貓 (out-of-level, the offending word) should now be introduced.
    const card = await learnerService.getCard({ kind: 'word', id: OUT_OF_LEVEL.id }, 'recognition');
    expect(card?.state).toBe('introduced');
  });
});

function chatConfigFor() {
  return { maxRegenerations: 2, knownSampleSize: 30, dueSampleSize: 10, newTargetsPerTurn: 3 };
}

describe('ChatService.recordNoLookupEvidence', () => {
  it('records chat_read_no_lookup for a due token that was not looked up', async () => {
    await seedKnownAndDue();
    const chat = new ChatService(db, lexicon, learnerService, new FakeTutorLLM(() => cleanResponse));
    await chat.recordNoLookupEvidence('錢', new Set(), new Date('2026-01-10'));

    const rows = await db.evidence.toArray();
    expect(rows.some((e) => e.kind === 'chat_read_no_lookup' && e.item.id === DUE_WORD.id)).toBe(true);
  });

  it('does NOT record evidence for a token that WAS looked up', async () => {
    await seedKnownAndDue();
    const chat = new ChatService(db, lexicon, learnerService, new FakeTutorLLM(() => cleanResponse));
    await chat.recordNoLookupEvidence('錢', new Set([DUE_WORD.id]), new Date('2026-01-10'));

    const rows = await db.evidence.toArray();
    expect(rows.some((e) => e.kind === 'chat_read_no_lookup')).toBe(false);
  });

  it('does not record evidence for a word with no card at all (never introduced)', async () => {
    const chat = new ChatService(db, lexicon, learnerService, new FakeTutorLLM(() => cleanResponse));
    await chat.recordNoLookupEvidence('少冰', new Set(), new Date('2026-01-02'));
    const rows = await db.evidence.toArray();
    expect(rows).toHaveLength(0);
  });
});

describe('ChatService.getSummary', () => {
  it('reports turn count, average coverage, and completed goal steps', async () => {
    await seedKnownAndDue();
    const llm = new FakeTutorLLM(() => ({ ...cleanResponse, goal_progress: [{ step: 'pay', done: true }] }));
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);
    await chat.sendLearnerTurn(conversationId, scenario, '...', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    const summary = await chat.getSummary(conversationId);
    expect(summary.turnCount).toBe(3);
    expect(summary.avgCoverage).toBeGreaterThanOrEqual(0.95);
    expect(summary.goalStepsDone).toEqual(['pay']);
  });

  it('lists words encountered (looked up or auto-introduced) within the conversation window', async () => {
    await seedKnownAndDue();
    const now = new Date('2026-01-01T12:00:00Z');
    const chat = new ChatService(db, lexicon, learnerService, new FakeTutorLLM(() => cleanResponse));
    const conversationId = await chat.startConversation(scenario, now);

    // A tap recorded mid-conversation...
    await learnerService.record(
      { item: { kind: 'word', id: TARGET_CANDIDATE.id }, skill: 'recognition', kind: 'chat_lookup_gloss', at: now },
      now,
    );
    // ...but evidence from before the conversation started must be excluded.
    await learnerService.record(
      { item: { kind: 'word', id: OUT_OF_LEVEL.id }, skill: 'recognition', kind: 'chat_lookup_gloss', at: new Date(now.getTime() - 86_400_000) },
      new Date(now.getTime() - 86_400_000),
    );

    const summary = await chat.getSummary(conversationId);
    expect(summary.wordsEncountered).toContain(TARGET_CANDIDATE.headword);
    expect(summary.wordsEncountered).not.toContain(OUT_OF_LEVEL.headword);
  });
});

describe('ChatService.maybeCompleteConversation', () => {
  it('appends the success line and ends the conversation once every goal step is done', async () => {
    await seedKnownAndDue();
    const llm = new FakeTutorLLM(() => ({ ...cleanResponse, goal_progress: [{ step: 'pay', done: true }] }));
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);
    await chat.sendLearnerTurn(conversationId, scenario, '...', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    const completed = await chat.maybeCompleteConversation(conversationId, scenario);
    expect(completed).toBe(true);

    const turns = await chat.getTurns(conversationId);
    expect(turns.at(-1)).toMatchObject({ role: 'npc', zh: scenario.successLine.zh });

    const conv = await db.conversations.get(conversationId);
    expect(conv?.endedAt).toBeDefined();
  });

  it('does nothing while goal steps remain incomplete', async () => {
    await seedKnownAndDue();
    const chat = new ChatService(db, lexicon, learnerService, new FakeTutorLLM(() => cleanResponse));
    const conversationId = await chat.startConversation(scenario);
    await chat.sendLearnerTurn(conversationId, scenario, '...', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });

    const completed = await chat.maybeCompleteConversation(conversationId, scenario);
    expect(completed).toBe(false);
    const conv = await db.conversations.get(conversationId);
    expect(conv?.endedAt).toBeUndefined();
  });

  it('is a no-op once already ended', async () => {
    await seedKnownAndDue();
    const llm = new FakeTutorLLM(() => ({ ...cleanResponse, goal_progress: [{ step: 'pay', done: true }] }));
    const chat = new ChatService(db, lexicon, learnerService, llm);
    const conversationId = await chat.startConversation(scenario);
    await chat.sendLearnerTurn(conversationId, scenario, '...', {
      learnerLevel: 'N2',
      scaffolding: 'high',
      englishFallback: false,
    });
    await chat.maybeCompleteConversation(conversationId, scenario);

    const secondCall = await chat.maybeCompleteConversation(conversationId, scenario);
    expect(secondCall).toBe(false);
    const turns = await chat.getTurns(conversationId);
    expect(turns.filter((t) => t.zh === scenario.successLine.zh)).toHaveLength(1);
  });
});

describe('ChatService targets follow the study order (Phase 14)', () => {
  const opts = { learnerLevel: 'N2' as const, scaffolding: 'high' as const, englishFallback: false };
  const focus = (ids: string[]) =>
    ({ enabled: true, focusItems: ids.map((id) => ({ kind: 'word', id })), reviewItems: [] }) as never;

  async function targetsFor(studyFocus: (() => Promise<never>) | undefined): Promise<string[]> {
    await seedKnownAndDue();
    let seen: string[] = [];
    const llm = new FakeTutorLLM((req) => {
      seen = req.vocab.targets as string[];
      return cleanResponse;
    });
    const chat = new ChatService(db, lexicon, learnerService, llm, undefined, undefined, undefined, undefined, studyFocus);
    const id = await chat.startConversation(scenario);
    await chat.sendLearnerTurn(id, scenario, '我要一杯珍珠奶茶', opts);
    return seen;
  }

  it('in ANY scenario, unmastered textbook items are the targets first', async () => {
    const targets = await targetsFor(async () => focus(['k0', 'k1']));
    expect(targets.slice(0, 2)).toEqual(['好的', '還']);
  });

  it('study order off or absent: the targets are the usual new words', async () => {
    const usual = await targetsFor(undefined);
    const off = await targetsFor(async () => ({ enabled: false, focusItems: [{ kind: 'word', id: 'k0' }], reviewItems: [] }) as never);
    expect(off).toEqual(usual);
    expect(usual).not.toContain('好的');
  });
});
