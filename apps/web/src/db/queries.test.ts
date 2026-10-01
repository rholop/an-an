import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario } from '@anan/core';
import { allChatLines } from './queries.js';
import { AnanDB } from './schema.js';

let db: AnanDB;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
});

afterEach(async () => {
  await db.delete();
});

const scenario: Scenario = {
  id: 'tea-shop',
  title: 'Ordering a drink',
  levelRange: { min: 'N1', max: 'L2' },
  npc: { id: 'clerk', name: '店員', personality: 'friendly', speechStyle: 'short', particles: [] },
  setting: 'A counter.',
  goalSteps: [{ id: 'pay', description: 'Pay', keywordHints: [] }],
  vocabExtras: [],
  opener: { zh: '歡迎光臨！', en: 'Welcome!' },
  successLine: { zh: '謝謝！', en: 'Thanks!' },
};

describe('allChatLines', () => {
  it('returns every turn, resolving the scenario title and NPC name from the matching conversation', async () => {
    const conversationId = await db.conversations.add({
      scenarioId: 'tea-shop',
      npcId: 'clerk',
      startedAt: new Date('2026-01-01'),
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
    });
    await db.turns.bulkAdd([
      {
        conversationId: conversationId as number,
        role: 'npc',
        zh: '歡迎光臨！',
        at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        conversationId: conversationId as number,
        role: 'learner',
        zh: '我要一杯珍珠奶茶',
        at: new Date('2026-01-01T00:01:00Z'),
      },
    ]);

    const lines = await allChatLines(db, [scenario]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      zh: '歡迎光臨！',
      role: 'npc',
      scenarioTitle: 'Ordering a drink',
      npcName: '店員',
    });
    expect(lines[1]).toMatchObject({
      zh: '我要一杯珍珠奶茶',
      role: 'learner',
      scenarioTitle: 'Ordering a drink',
    });
  });

  it('falls back to the scenarioId when the scenario is not in the provided list', async () => {
    const conversationId = await db.conversations.add({
      scenarioId: 'unknown-scenario',
      npcId: 'x',
      startedAt: new Date('2026-01-01'),
      goalStepsDone: [],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
    });
    await db.turns.add({
      conversationId: conversationId as number,
      role: 'npc',
      zh: '你好',
      at: new Date('2026-01-01'),
    });

    const lines = await allChatLines(db, [scenario]);
    expect(lines[0]?.scenarioTitle).toBe('unknown-scenario');
    expect(lines[0]?.npcName).toBeUndefined();
  });

  it('returns an empty array when there are no turns at all', async () => {
    expect(await allChatLines(db, [scenario])).toEqual([]);
  });
});
