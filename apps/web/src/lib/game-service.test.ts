import Dexie from 'dexie';
import { exportBackup, importBackup } from '../db/backup.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LEARNER_CONFIG, Lexicon, totalPoints, type Scenario, type Word } from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { ChatService } from './chat-service.js';
import { FakeTutorLLM } from './fake-tutor-llm.js';
import { GameService } from './game-service.js';
import { conversationRecords, loadGameSnapshot } from './game-data.js';
import { LearnerService } from './learner-service.js';

let db: AnanDB;
let game: GameService;
let learner: LearnerService;
const now = new Date(2026, 2, 10, 12);

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  game = new GameService(db);
  learner = new LearnerService(new DexieLearnerRepo(db), DEFAULT_LEARNER_CONFIG, (e, p) =>
    game.onEvidence(e, p),
  );
});
afterEach(async () => {
  await db.delete();
});

const word = (id: string, headword: string, extra: Partial<Word> = {}): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [...headword],
  tags: [],
  ...extra,
});
const lexicon = new Lexicon([
  word('a', '咖啡'),
  word('b', '珍珠奶茶'),
  word('c', '好'),
  word('d', '謝謝'),
  word('e', '好的'),
]);

const scenario: Scenario = {
  id: 'cafe',
  title: 'Café',
  levelRange: { min: 'N1', max: 'L2' },
  npc: { id: 'n', name: '店員', personality: 'p', speechStyle: 's', particles: [] },
  setting: 's',
  goalSteps: [{ id: 'order', description: 'Order', keywordHints: [] }],
  vocabExtras: ['咖啡', '珍珠奶茶'],
  opener: { zh: '歡迎光臨！', en: 'Welcome!' },
  successLine: { zh: '謝謝！', en: 'Thanks!' },
};

const ev = (
  kind: 'review_good' | 'review_again' | 'chat_read_no_lookup' | 'cloze_correct_nohint',
  id = 'a',
) => ({ item: { kind: 'word', id }, skill: 'recognition', kind, at: now }) as const;

describe('points ledger', () => {
  it('pays for successful recalls via the LearnerService hook, never for lookups or failures', async () => {
    await learner.record({ ...ev('review_good') }, now);
    await learner.record({ ...ev('review_again', 'b') }, now);
    await learner.record({ ...ev('chat_read_no_lookup', 'c') }, now);
    const rewards = await game.allRewards();
    expect(rewards.map((r) => [r.kind, r.points])).toEqual([['recall_correct', 2]]);
  });

  it('is idempotent: the same recall on the same day is paid once', async () => {
    await learner.record({ ...ev('cloze_correct_nohint') }, now);
    await learner.record({ ...ev('cloze_correct_nohint') }, now);
    expect(totalPoints(await game.allRewards())).toBe(2);
  });

  it('awards scenario, journal and error-bank behaviours, and nothing else', async () => {
    await game.onScenarioCompleted({
      id: 1,
      scenarioId: 'cafe',
      npcId: 'n',
      startedAt: now,
      endedAt: now,
      goalStepsDone: [],
      completed: true,
      stuckCount: 0,
      englishFallbackUsed: false,
    });
    await game.onScenarioCompleted({
      id: 2,
      scenarioId: 'cafe',
      npcId: 'n',
      startedAt: now,
      endedAt: now,
      goalStepsDone: [],
      completed: true,
      stuckCount: 1,
      englishFallbackUsed: false,
    });
    await game.onJournalFinished('e1', [0, 2], now);
    await game.onErrorFixed('e1:0', now);
    const kinds = (await game.allRewards()).map((r) => r.kind).sort();
    expect(kinds).toEqual([
      'error_fixed',
      'journal_entry',
      'scenario_completed',
      'scenario_completed',
      'scenario_unassisted',
      'self_correction',
      'self_correction',
    ]);
  });

  it('streaks are off by default and persist when enabled', async () => {
    expect((await game.getStreakConfig()).enabled).toBe(false);
    await game.setStreakConfig({ enabled: true, freezeDaysPerWeek: 1 });
    expect(await game.getStreakConfig()).toEqual({ enabled: true, freezeDaysPerWeek: 1 });
  });
});

describe('scenario tracking in ChatService', () => {
  const chat = () =>
    new ChatService(db, lexicon, learner, new FakeTutorLLM(), undefined, undefined, (c) =>
      game.onScenarioCompleted(c),
    );

  it('records stuck presses and English fallback, then stars + points on completion', async () => {
    const svc = chat();
    const id = await svc.startConversation(scenario, now);
    await svc.recordStuck(id);
    await svc.recordStuck(id);
    await db.conversations.update(id, { goalStepsDone: ['order'] });
    expect(await svc.maybeCompleteConversation(id, scenario, now)).toBe(true);

    const [rec] = await conversationRecords(db);
    expect(rec).toMatchObject({
      scenarioId: 'cafe',
      completed: true,
      stuckCount: 2,
      englishFallbackUsed: false,
    });
    expect((await game.allRewards()).map((r) => r.kind)).toEqual(['scenario_completed']); // stuck: no unassisted bonus
  });

  it('an unassisted completion earns the bonus; ending early is not "completed"', async () => {
    const svc = chat();
    const a = await svc.startConversation(scenario, now);
    await db.conversations.update(a, { goalStepsDone: ['order'] });
    await svc.maybeCompleteConversation(a, scenario, now);
    const b = await svc.startConversation(scenario, now);
    await svc.endConversation(b, now);
    const recs = await conversationRecords(db);
    expect(recs.map((r) => r.completed)).toEqual([true, false]);
    expect((await game.allRewards()).map((r) => r.kind).sort()).toEqual([
      'scenario_completed',
      'scenario_unassisted',
    ]);
  });
});

describe('loadGameSnapshot', () => {
  it('builds the garden, scenario map and coverage from local data', async () => {
    const jan1 = new Date(2026, 0, 1);
    await learner.record({ ...ev('review_good', 'a'), at: jan1 }, jan1);
    const snap = await loadGameSnapshot(db, lexicon, [scenario], now);
    expect(snap.nodes[0]).toMatchObject({ unlocked: true, attempts: 0 });
    expect(snap.plots.map((p) => p.id)).toEqual(['scenario:cafe']);
    expect(snap.plants[0]).toMatchObject({ headword: '咖啡' });
    expect(snap.plants[0]!.wilt).not.toBe('healthy'); // reviewed months ago
    const cov = snap.coverage.get('cafe')!;
    expect(cov.coverage).toBeGreaterThan(0);
    expect(cov.coverage).toBeLessThan(1);
    expect(cov.missing).toContain('珍珠奶茶');
  });

  it('survives a v2->v3 style legacy conversation without game fields', async () => {
    await db.conversations.add({
      scenarioId: 'cafe',
      npcId: 'n',
      startedAt: now,
      goalStepsDone: [],
    } as never);
    const [rec] = await conversationRecords(db);
    expect(rec).toMatchObject({ completed: false, stuckCount: 0, englishFallbackUsed: false });
  });
});

describe('persistence', () => {
  it('upgrades a v2 database: conversations gain game fields, data is kept', async () => {
    const name = `anan-upgrade-${Math.random()}`;
    const v2 = new Dexie(name);
    v2.version(1).stores({
      items: 'pk, state, [item.id+skill], card.due, card.lapses, leech',
      evidence: '++id, at, [item.id], kind',
      settings: 'key',
      meta: 'key',
      customWords: 'id, headword',
      conversations: '++id, scenarioId, startedAt',
      turns: '++id, conversationId, at',
    });
    v2.version(2).stores({
      journalEntries: 'id, createdAt, status',
      journalReviews: 'entryId, createdAt',
      errorItems: 'id, journalEntryId, card.due, pattern',
    });
    await v2.open();
    await v2
      .table('conversations')
      .add({ scenarioId: 'cafe', npcId: 'n', startedAt: now, goalStepsDone: ['order'] });
    v2.close();

    const upgraded = new AnanDB(name);
    const [c] = await upgraded.conversations.toArray();
    expect(c).toMatchObject({
      goalStepsDone: ['order'],
      completed: false,
      stuckCount: 0,
      englishFallbackUsed: false,
    });
    expect(await upgraded.rewardEvents.count()).toBe(0);
    await upgraded.delete();
  });

  it('conversations, turns and the points ledger survive export -> import', async () => {
    const svc = new ChatService(
      db,
      lexicon,
      learner,
      new FakeTutorLLM(),
      undefined,
      undefined,
      (c) => game.onScenarioCompleted(c),
    );
    const id = await svc.startConversation(scenario, now);
    await svc.recordStuck(id);
    await db.conversations.update(id, { goalStepsDone: ['order'] });
    await svc.maybeCompleteConversation(id, scenario, now);
    const before = {
      c: await db.conversations.toArray(),
      t: await db.turns.toArray(),
      r: await db.rewardEvents.toArray(),
    };

    const backup = JSON.parse(JSON.stringify(await exportBackup(db)));
    await importBackup(db, backup);
    expect({
      c: await db.conversations.toArray(),
      t: await db.turns.toArray(),
      r: await db.rewardEvents.toArray(),
    }).toEqual(before);

    delete backup.conversations;
    delete backup.rewardEvents;
    backup.schemaVersion = 2;
    await expect(importBackup(db, backup)).resolves.toBeDefined(); // pre-Phase-6 backups still import
  });
});
