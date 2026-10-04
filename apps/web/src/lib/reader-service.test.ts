import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Lexicon,
  type Evidence,
  type SentenceBankEntry,
  type SentenceGenResponse,
  type Word,
} from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { FakeTutorLLM } from './fake-tutor-llm.js';
import { LearnerService } from './learner-service.js';
import { ReaderService } from './reader-service.js';

let db: AnanDB;
let learnerService: LearnerService;

beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

const NOW = new Date('2026-03-10T12:00:00Z');
const PAST = new Date('2026-03-01T00:00:00Z');
const DAY = 86_400_000;

function word(id: string, headword: string, level: Word['level'] = 'N1'): Word {
  return {
    id, headword, variants: [], pos: ['N'], level, source: 'tocfl', pinyin: '', pinyinNumeric: '',
    zhuyin: '', glossEn: `gloss of ${headword}`, chars: [...headword], tags: [],
  };
}
const WORDS = [
  word('w-wo', '我'), word('w-qu', '去'), word('w-xihuan', '喜歡'), word('w-kafei', '咖啡'),
  word('w-hao', '好'), word('w-chi', '吃'), word('w-bianli', '便利商店', 'N2'),
  word('w-yeshi', '夜市', 'N2'), word('w-laji', '垃圾車', 'L1'), word('w-jiche', '機車', 'L1'),
];
const lexicon = new Lexicon(WORDS);
const KNOWN = ['w-wo', 'w-qu', 'w-xihuan', 'w-kafei', 'w-hao', 'w-chi'];

async function seedCard(wordId: string, kind: Evidence['kind'], at: Date) {
  await learnerService.record({ item: { kind: 'word', id: wordId }, skill: 'recognition', kind, at }, at);
}
/** Known (review state) words + one due word. */
async function seedLearner(dueId = 'w-bianli') {
  for (const id of KNOWN) {
    await seedCard(id, 'review_good', PAST);
    await seedCard(id, 'review_good', new Date(PAST.getTime() + 3 * DAY));
  }
  // a word that is due now: reviewed once long ago, so its due date has passed
  await seedCard(dueId, 'review_good', PAST);
}

let n = 0;
const entry = (zh: string, targetWordId: string, over: Partial<SentenceBankEntry> = {}): SentenceBankEntry => ({
  id: `bank-${++n}`, zh, en: `en ${n}`, targetWordId, level: 'N1', tokens: [], source: 'generated', doubtful: false, ...over,
});

function service(over: Partial<ConstructorParameters<typeof ReaderService>[0]> = {}) {
  return new ReaderService({
    db, learnerService, lexicon, staticBank: [], scenarios: [], rand: () => 0.3, ...over,
  });
}

describe('ReaderService.next', () => {
  it('uses the bank without calling the LLM', async () => {
    await seedLearner();
    const llm = new FakeTutorLLM();
    const r = await service({ staticBank: [entry('我去便利商店', 'w-bianli')], llm }).next({ focus: 'mixed', level: 'L2', now: NOW });
    expect(r?.pick.sentence.zh).toBe('我去便利商店');
    expect(r?.generated).toBe(false);
    expect(llm.sentenceCalls).toBe(0);
  });

  it('twenty presses with no network always return something, from the bank and own lines only', async () => {
    await seedLearner();
    const conv = await db.conversations.add({
      scenarioId: 's', npcId: 'n', startedAt: PAST, goalStepsDone: [], completed: false, stuckCount: 0, englishFallbackUsed: false,
    });
    await db.turns.add({ conversationId: conv!, role: 'npc', zh: '我喜歡去便利商店。', en: 'I like the shop.', at: PAST });
    const failing = { generateSentences: () => Promise.reject(new Error('offline')) };
    const staticBank = [entry('我去便利商店', 'w-bianli'), entry('我喜歡便利商店', 'w-bianli')];
    const svc = service({ staticBank, llm: failing, scenarios: [] });
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = await svc.next({ focus: 'mixed', level: 'L2', sessionIds: seen, now: new Date(NOW.getTime() + i) });
      expect(r).not.toBeNull();
      expect(r!.generated).toBe(false);
      await svc.markShown(r!.pick.sentence.id, new Date(NOW.getTime() + i));
      seen.add(r!.pick.sentence.id);
    }
  });

  it('does not repeat a sentence within 7 days, and does after the window', async () => {
    await seedLearner();
    const a = entry('我去便利商店', 'w-bianli');
    const b = entry('我喜歡便利商店', 'w-bianli');
    const svc = service({ staticBank: [a, b] });
    await svc.markShown(a.id, new Date(NOW.getTime() - 2 * DAY));
    for (const rand of [0, 0.4, 0.9]) {
      const r = await service({ staticBank: [a, b], rand: () => rand }).next({ focus: 'mixed', level: 'L2', now: NOW });
      expect(r?.pick.sentence.id).toBe(b.id);
    }
    await db.readerShown.clear();
    await svc.markShown(a.id, new Date(NOW.getTime() - 8 * DAY));
    await svc.markShown(b.id, new Date(NOW.getTime() - 1 * DAY));
    const later = await svc.next({ focus: 'mixed', level: 'L2', now: NOW });
    expect(later?.pick.sentence.id).toBe(a.id);
  });

  it('the level picker changes which sentences appear', async () => {
    await seedLearner();
    const svc = service({ staticBank: [entry('我去便利商店', 'w-bianli', { level: 'L3' })] });
    const low = await svc.next({ focus: 'mixed', level: 'L1', now: NOW, allowLive: false });
    expect(low?.pick.exact ?? false).toBe(false); // above-level sentence is not offered as exact
    const high = await svc.next({ focus: 'mixed', level: 'L3', now: NOW, allowLive: false });
    expect(high?.pick.exact).toBe(true);
  });

  it('generates live when nothing local fits, validates, saves it as generated-live, and reuses it next time', async () => {
    await seedLearner();
    const llm = new FakeTutorLLM(undefined, undefined, (req): SentenceGenResponse => ({
      sentences: [
        { zh: '垃圾車機車夜市垃圾車', en: 'bad', tokens: [] }, // too many unknown words
        { zh: `我去${req.word.headword}`, en: 'I go to the shop', tokens: [] },
      ],
    }));
    const svc = service({ llm });
    const first = await svc.next({ focus: 'review', level: 'L2', now: NOW });
    expect(first?.generated).toBe(true);
    expect(first?.pick.sentence.zh).toBe('我去便利商店');
    expect(first?.pick.exact).toBe(true);
    expect(llm.sentenceCalls).toBe(1);

    const rows = await db.liveSentences.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ zh: '我去便利商店', source: 'generated-live', targetWordId: 'w-bianli' });
    expect(rows.some((r) => r.zh.includes('垃圾車機車'))).toBe(false); // the failing one was never saved

    // second press is served from the profile's own bank: no new network call
    const second = await svc.next({ focus: 'review', level: 'L2', now: new Date(NOW.getTime() + 1000) });
    expect(second?.generated).toBe(false);
    expect(second?.pick.sentence.zh).toBe('我去便利商店');
    expect(llm.sentenceCalls).toBe(1);
  });

  it('never shows a failing generated sentence without the closest-match flag', async () => {
    await seedLearner();
    const llm = new FakeTutorLLM(undefined, undefined, () => ({
      sentences: [{ zh: '垃圾車機車夜市垃圾車', en: 'bad', tokens: [] }],
    }));
    const bank = [entry('我去便利商店機車', 'w-bianli')]; // 1 unknown in a short sentence
    const r = await service({ llm, staticBank: bank }).next({ focus: 'mixed', level: 'L2', now: NOW });
    expect(r?.generated).toBe(false);
    expect(r?.pick.sentence.zh).toBe('我去便利商店機車');
    expect(r?.pick.exact).toBe(false);
    expect(await db.liveSentences.count()).toBe(0);
  });

  it('skips generation when no household code is set', async () => {
    await seedLearner();
    const llm = new FakeTutorLLM();
    const r = await service({ llm, canGenerate: () => false }).next({ focus: 'review', level: 'L2', now: NOW });
    expect(r).toBeNull();
    expect(llm.sentenceCalls).toBe(0);
  });

  it('New words focus offers exactly one frontier word', async () => {
    await seedLearner();
    const bank = [entry('我去垃圾車', 'w-laji', { level: 'L1' }), entry('我喜歡咖啡', 'w-kafei')];
    const r = await service({ staticBank: bank }).next({ focus: 'new', level: 'L1', now: NOW, allowLive: false });
    expect(r?.pick.sentence.zh).toBe('我去垃圾車');
    expect(r?.pick.reason).toBe('New word: 垃圾車');
  });
});

describe('ReaderService evidence', () => {
  it('tags lookups with source reader and the sentence id', async () => {
    await service().recordLookup('w-bianli', 'chat_lookup_gloss', 'bank-1', NOW);
    const [e] = await db.evidence.toArray();
    expect(e).toMatchObject({ kind: 'chat_lookup_gloss', context: { source: 'reader', refId: 'bank-1' } });
  });

  it('pressing New sentence records chat_read_no_lookup for due/learning words that were not looked up', async () => {
    await seedLearner('w-bianli');
    await seedCard('w-yeshi', 'chat_lookup_gloss', PAST); // introduced, not yet due/learning
    await db.evidence.clear();
    const svc = service();
    const count = await svc.recordNoLookup(['w-bianli', 'w-wo'], new Set(), 'bank-1', NOW);
    // 便利商店 is due; 我 is known and not due -> only the due word counts
    expect(count).toBe(1);
    const rows = await db.evidence.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'chat_read_no_lookup',
      item: { id: 'w-bianli' },
      context: { source: 'reader', refId: 'bank-1' },
    });
  });

  it('a looked-up due word does not also get a no-lookup record', async () => {
    await seedLearner('w-bianli');
    await db.evidence.clear();
    expect(await service().recordNoLookup(['w-bianli'], new Set(['w-bianli']), 'bank-1', NOW)).toBe(0);
    expect(await db.evidence.count()).toBe(0);
  });

  it('Show English counts as a lookup for the sentence’s unknown words only', async () => {
    await seedLearner();
    await db.evidence.clear();
    const recorded = await service().recordRevealEnglish(['w-wo', 'w-yeshi', 'w-laji'], new Set(['w-laji']), 's1', NOW);
    expect(recorded).toEqual(['w-yeshi']); // 我 is known, 垃圾車 was already looked up
    const rows = await db.evidence.toArray();
    expect(rows.map((r) => [r.kind, r.item.id, r.context?.source])).toEqual([
      ['chat_lookup_gloss', 'w-yeshi', 'reader'],
    ]);
  });
});

describe('ReaderService.next — Lesson focus (Phase 12)', () => {
  const tbEntry = (zh: string, lesson: number) =>
    entry(zh, 'w-wo', { lesson, tags: ['textbook:laixue-1', `textbook:laixue-1:L${String(lesson).padStart(2, '0')}`], source: 'generated' });
  const sentences = [tbEntry('我去喝咖啡。', 3), tbEntry('我喜歡吃。', 3), tbEntry('我去吃。', 4), tbEntry('我好。', 2)];

  it('offers only sentences tagged with the current lesson', async () => {
    await seedLearner();
    const reader = service({ lesson: { bookId: 'laixue-1', n: 3, sentences }, rand: () => 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r = await reader.next({ focus: 'lesson', level: 'N1', sessionIds: seen, now: NOW });
      expect(r).not.toBeNull();
      expect(['我去喝咖啡。', '我喜歡吃。']).toContain(r!.pick.sentence.zh);
      expect(r!.pick.focus).toBe('lesson');
      expect(r!.generated).toBe(false);
      seen.add(r!.pick.sentence.id);
    }
  });

  it('never repeats a sentence until the lesson pool is used up', async () => {
    const reader = service({ lesson: { bookId: 'laixue-1', n: 3, sentences }, rand: () => 0 });
    const a = await reader.next({ focus: 'lesson', level: 'N1', now: NOW });
    const b = await reader.next({ focus: 'lesson', level: 'N1', sessionIds: new Set([a!.pick.sentence.id]), now: NOW });
    expect(b!.pick.sentence.id).not.toBe(a!.pick.sentence.id);
  });

  it('Phase 13: a book-2 lesson is found by its own tag, and a harder level than the chosen one is hidden', async () => {
    const b2 = [
      entry('我去喝茶。', 'w-wo', { lesson: 3, textbookId: 'laixue-2', level: 'L1', tags: ['textbook:laixue-2', 'textbook:laixue-2:L03'], source: 'generated' }),
    ];
    const mix = [...sentences, ...b2];
    const reader = service({ lesson: { bookId: 'laixue-2', n: 3, sentences: mix }, rand: () => 0 });
    const ok = await reader.next({ focus: 'lesson', level: 'L1', now: NOW });
    expect(ok!.pick.sentence.zh).toBe('我去喝茶。');
    expect(ok!.pick.sentence.sourceLabel).toBe('來學華語 2 · L3');
    expect(await reader.next({ focus: 'lesson', level: 'N1', now: NOW })).toBeNull();
  });

  it('returns nothing (and never goes live) when the lesson has no sentences', async () => {
    const reader = service({ lesson: { bookId: 'laixue-1', n: 9, sentences }, llm: { generateSentences: async () => { throw new Error('should not be called'); } } });
    expect(await reader.next({ focus: 'lesson', level: 'N1', now: NOW })).toBeNull();
  });
});
