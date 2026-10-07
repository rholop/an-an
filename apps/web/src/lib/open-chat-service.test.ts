import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Lexicon,
  type Lesson,
  type OpenTurnRequest,
  type Textbook,
  type TurnResponse,
  type Word,
} from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { FakeTutorLLM } from './fake-tutor-llm.js';
import { LearnerService } from './learner-service.js';
import { OpenChatService, type OpenChatEnvironment } from './open-chat-service.js';

let db: AnanDB;
let learnerService: LearnerService;
beforeEach(() => {
  db = new AnanDB(`anan-open-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

let n = 0;
const w = (headword: string, level: Word['level'], glossEn: string, tags: string[] = []): Word => ({
  id: `o${++n}`,
  headword,
  variants: [],
  pos: ['N'],
  level,
  source: level ? 'tocfl' : 'supplement',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags,
});

const KNOWN = ['我', '你', '喜歡', '吃', '飯', '喝'].map((h) => w(h, 'N1', h));
const TEACHER = w('老師', 'N1', 'teacher');
const MOVIE = w('電影', 'L1', 'movie');
const SCHOOL = w('學校', 'N2', 'school');
const FRIEND = w('朋友', 'N2', 'friend');
const COFFEE = w('咖啡', 'L1', 'coffee');
const NEWS = w('新聞', 'L3', 'news');
const ECON = w('經濟', 'L4', 'economy');
const GOV = w('政府', 'L4', 'government');
const PARTICLES = ['嗎', '啊', '和', '呢'].map((h) => w(h, null, h, ['particle']));
const lexicon = new Lexicon([...KNOWN, TEACHER, MOVIE, SCHOOL, FRIEND, COFFEE, NEWS, ECON, GOV, ...PARTICLES]);

const lesson = (nn: number, over: Partial<Lesson>): Lesson => ({
  id: `laixue-1-L0${nn}`,
  n: nn,
  titleZh: '',
  titleEn: '',
  topic: `Theme ${nn}`,
  objectives: [],
  vocab: [],
  supplementary: [],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
  ...over,
});
const books: Textbook[] = [
  {
    id: 'laixue-1',
    titleZh: '',
    titleEn: '',
    lessons: [
      lesson(1, { vocab: [TEACHER.id], topic: 'Occupations (I)' }),
      lesson(2, { vocab: [MOVIE.id] }),
      lesson(3, { vocab: [COFFEE.id] }),
      lesson(4, { vocab: [GOV.id] }),
    ],
  },
];

const env = (over: Partial<OpenChatEnvironment> = {}): OpenChatEnvironment => ({
  books: () => books,
  myClass: () => ({ enabled: true, textbookId: 'laixue-1', currentLesson: 1 }),
  ...over,
});

const NOW = new Date('2026-10-07T10:00:00Z');
const opts = { learnerLevel: 'N2' as const, scaffolding: 'high' as const, englishFallback: false };

async function seedKnown() {
  await learnerService.recordBulk(
    KNOWN.map((k) => ({
      item: { kind: 'word' as const, id: k.id },
      skill: 'recognition' as const,
      kind: 'anki_import_seen' as const,
      at: NOW,
    })),
    NOW,
  );
}

const reply = (zh: string, over: Partial<TurnResponse> = {}): TurnResponse => ({
  reply_zh: zh,
  reply_en: 'x',
  tokens: [],
  targets_used: [],
  suggested_replies: [{ zh: '好', en: 'ok' }],
  goal_progress: [],
  ...over,
});

const service = (llm: FakeTutorLLM, e: OpenChatEnvironment = env()) =>
  new OpenChatService(db, lexicon, learnerService, llm, e, undefined, () => 0.1);

describe('start and topic', () => {
  it('stores kind "open" with the topic and an authored opener; no LLM call', async () => {
    const llm = new FakeTutorLLM();
    const svc = service(llm);
    const id = await svc.startConversation('food you like', NOW);
    const conv = await db.conversations.get(id);
    expect(conv).toMatchObject({ kind: 'open', topic: 'food you like', scenarioId: 'open-chat', npcId: 'anan' });
    expect((await svc.getTurns(id))[0]).toMatchObject({ role: 'npc' });
    expect(llm.openCalls).toHaveLength(0);
    expect(llm.topicWordCalls).toBe(0);
  });

  it('"Just chat": no topic, the opener is a simple authored question', async () => {
    const svc = service(new FakeTutorLLM());
    const id = await svc.startConversation('  ', NOW);
    expect((await db.conversations.get(id))!.topic).toBe('');
    expect((await svc.getTurns(id))[0]!.zh).toMatch(/[？]/);
  });

  it('topic words are cached on the device: the second open of a topic makes no call', async () => {
    const llm = new FakeTutorLLM();
    const svc = service(llm);
    expect(await svc.getTopicWords('Food you like', 'N2')).toEqual(['吃', '飯', '喝', '咖啡']);
    expect(await svc.getTopicWords('food  you like', 'N2')).toEqual(['吃', '飯', '喝', '咖啡']);
    expect(llm.topicWordCalls).toBe(1);
    await svc.getTopicWords('food you like', 'L1'); // another level = another list
    expect(llm.topicWordCalls).toBe(2);
    // a fresh service (new session) still reads the cache
    const again = service(llm);
    await again.getTopicWords('food you like', 'N2');
    expect(llm.topicWordCalls).toBe(2);
    expect(await service(llm).getTopicWords('   ', 'N2')).toEqual([]);
  });
});

describe('sendLearnerTurn', () => {
  it('a reply of tier A words passes first time and stores the tier mix', async () => {
    await seedKnown();
    const llm = new FakeTutorLLM(undefined, {}, undefined, () => reply('你喜歡吃飯嗎？'));
    const svc = service(llm);
    const id = await svc.startConversation('food', NOW);
    const r = await svc.sendLearnerTurn(id, '我喜歡吃', opts, NOW);
    expect(r.attempts).toBe(1);
    expect(r.report.pass).toBe(true);
    expect(r.npcTurn.validatorReport?.tiers).toMatchObject({ a: 2, b: 0, c: 0, allowed: 3, usesUpcoming: false }); // 喜歡 and 吃 were typed by the learner, 嗎 is a particle
    expect(r.npcTurn.glosses).toBeUndefined();
    // the request is the open shape: topic, tiers, no scenario fields
    const req = llm.openCalls[0]!;
    expect(req.mode).toBe('open');
    expect(req.topic).toBe('food');
    expect(req.tiers.a).toEqual(expect.arrayContaining(['我', '你', '喜歡', '吃', '飯', '喝']));
    expect(req.tiers.a).toEqual(expect.arrayContaining(['老師', '電影', '咖啡'])); // next three lessons
    expect(req.tiers.a).not.toContain('政府'); // lesson 4: not in the next three
    expect(req.history.at(-1)).toMatchObject({ role: 'learner', zh: '我喜歡吃' });
  });

  it('regenerates once with feedback naming the words, then keeps the better attempt with inline glosses', async () => {
    await seedKnown();
    const replies = ['你喜歡新聞和經濟和政府嗎？', '你喜歡吃飯喝我經濟嗎？'];
    const llm = new FakeTutorLLM(undefined, {}, undefined, (_r, i) => reply(replies[i]!));
    const svc = service(llm);
    const id = await svc.startConversation('news', NOW);
    const r = await svc.sendLearnerTurn(id, '新聞', { ...opts, learnerLevel: 'N1' }, NOW);
    expect(r.attempts).toBe(2); // first try + ONE regeneration
    expect(llm.openCalls[1]!.feedback).toContain('經濟'); // names the offenders (新聞 was typed: free)
    // the learner typed 新聞, so it is free; only 經濟 is a tier C word left (≤1): second reply passes
    expect(r.report.pass).toBe(true);
    expect(r.npcTurn.zh).toBe('你喜歡吃飯喝我經濟嗎？');
    expect(r.npcTurn.glosses).toEqual([{ text: '經濟', gloss: 'economy' }]);
  });

  it('when the last attempt still fails it is shown anyway, glossed, and the words are introduced', async () => {
    await seedKnown();
    const llm = new FakeTutorLLM(undefined, {}, undefined, () => reply('你喜歡經濟和政府和學校嗎？'));
    const svc = service(llm);
    const id = await svc.startConversation('', NOW);
    const r = await svc.sendLearnerTurn(id, '我喜歡', { ...opts, learnerLevel: 'N1' }, NOW);
    expect(r.attempts).toBe(2);
    expect(r.report.pass).toBe(false);
    expect(r.npcTurn.validatorReport?.pass).toBe(false);
    expect(r.npcTurn.glosses?.map((g) => g.text)).toEqual(expect.arrayContaining(['經濟', '政府', '學校']));
    const card = await learnerService.getCard({ kind: 'word', id: ECON.id }, 'recognition');
    expect(card?.state).toBe('introduced');
  });

  it('records which turns used an upcoming-lesson word', async () => {
    await seedKnown();
    const llm = new FakeTutorLLM(undefined, {}, undefined, () => reply('你喜歡老師嗎？'));
    const svc = service(llm);
    const id = await svc.startConversation('school', NOW);
    const r = await svc.sendLearnerTurn(id, '我喜歡', opts, NOW);
    expect(r.npcTurn.validatorReport?.tiers?.usesUpcoming).toBe(true);
    expect(r.npcTurn.validatorReport?.tiers?.upcomingIds).toEqual([TEACHER.id]);
  });

  it('changing the topic ("New topic") rebuilds the word list for the next turn', async () => {
    await seedKnown();
    const llm = new FakeTutorLLM(undefined, {}, undefined, () => reply('你喜歡吃飯嗎？'), (req) => (req.topic === 'movies' ? ['電影'] : ['吃']));
    const svc = service(llm);
    const id = await svc.startConversation('food', NOW);
    await svc.sendLearnerTurn(id, '你好', opts, NOW);
    await svc.setTopic(id, 'movies');
    await svc.sendLearnerTurn(id, '你好', opts, NOW);
    expect(llm.openCalls.map((c) => c.topic)).toEqual(['food', 'movies']);
    expect(llm.topicWordCalls).toBe(2);
  });

  it('a failed topic-word call does not stop the chat', async () => {
    await seedKnown();
    const llm = new FakeTutorLLM(undefined, {}, undefined, () => reply('你喜歡吃飯嗎？'));
    llm.generateTopicWords = async () => {
      throw new Error('429');
    };
    const svc = service(llm);
    const id = await svc.startConversation('food', NOW);
    await expect(svc.sendLearnerTurn(id, '你好', opts, NOW)).resolves.toMatchObject({ attempts: 1 });
  });

  it('long chats send the last 12 turns plus a summary refreshed every 6 turns', async () => {
    await seedKnown();
    const llm = new FakeTutorLLM(undefined, {}, undefined, () => reply('你喜歡吃飯嗎？'));
    const svc = service(llm);
    const id = await svc.startConversation('food', NOW);
    for (let i = 0; i < 12; i++) await svc.sendLearnerTurn(id, `我喜歡吃${i}`, opts, NOW);
    // 1 opener + 12 × (learner + npc) = 25 turns stored; the last request carried the final 12
    const last = llm.openCalls.at(-1) as OpenTurnRequest;
    expect(last.history.length).toBeLessThanOrEqual(12);
    expect(last.summary).toBeTruthy();
    const conv = await db.conversations.get(id);
    expect(conv!.summarizedUpTo).toBeGreaterThan(12);
    // no summary was sent while the chat still fit in the window
    expect(llm.openCalls[0]!.summary).toBeUndefined();
    const at = (k: number) => llm.openCalls[k]!.summary;
    expect(at(5)).toBeUndefined(); // 12 turns: still fits
    expect(at(6)).toBeTruthy(); // the 13th turn forces the first summary
  });
});

describe('summary and add to review', () => {
  it('reports the tier mix, the share of turns with an upcoming word, and new words met', async () => {
    await seedKnown();
    // A tier B word needs ≥ 6 tier A words around it to stay under 85%/15% in one reply.
    const script = ['你喜歡老師嗎？', '你喜歡吃飯嗎？', '你吃我喝你吃飯喝朋友嗎？', '你吃我喝你吃飯喝學校和電影嗎？'];
    const llm = new FakeTutorLLM(undefined, {}, undefined, (_r, i) => reply(script[i]!));
    const svc = service(llm);
    const id = await svc.startConversation('school', NOW);
    for (let i = 0; i < 4; i++) await svc.sendLearnerTurn(id, '我喜歡', opts, new Date(NOW.getTime() + i));
    await svc.endConversation(id, new Date(NOW.getTime() + 10));
    const s = await svc.getSummary(id);
    expect(s.learnerTurns).toBe(4);
    expect(s.upcomingTurnShare).toBeCloseTo(2 / 4); // 老師 and 電影 are upcoming
    expect(s.tierShareA).toBeGreaterThan(0.7);
    expect(s.wordsMet.map((x) => x.headword)).toEqual(expect.arrayContaining(['老師', '朋友', '學校', '電影']));
    expect(s.wordsMet.every((x) => !x.lookedUp)).toBe(true);

    await svc.addToReview([FRIEND.id]);
    const card = await learnerService.getCard({ kind: 'word', id: FRIEND.id }, 'recognition');
    expect(card?.state).toBe('introduced');
  });
});

describe('scripted run: 20 turns on 5 topics at Novice and L1 (the pipeline, with a tier-obeying fake)', () => {
  // This does NOT measure a real model: the fake builds each reply from the tier lists it is
  // sent, with one deliberately hard topic where it also uses a tier C word.
  const topics = ['food', 'weekend', 'family', 'work', 'news'];
  for (const level of ['N1', 'L1'] as const) {
    it(`meets the tier limits on ≥ 90% of replies and uses upcoming words on ≥ 50% (${level})`, async () => {
      await seedKnown();
      const llm = new FakeTutorLLM(
        undefined,
        {},
        undefined,
        (req, i) => {
          const a = req.tiers.a;
          const upcoming = ['老師', '電影', '咖啡'].filter((x) => a.includes(x));
          const base = ['你', '喜歡', '吃'];
          const text =
            req.topic === 'news'
              ? `你${upcoming[i % upcoming.length] ?? '吃'}新聞嗎？` // one tier C word
              : `${base.join('')}${i % 4 === 3 ? '飯' : (upcoming[i % upcoming.length] ?? '飯')}嗎？`;
          return reply(text);
        },
        (req) => (req.topic === 'news' ? ['新聞', '經濟', '政府'] : ['吃', '飯']),
      );
      const svc = service(llm);
      let passed = 0;
      let upcomingTurns = 0;
      let total = 0;
      for (const topic of topics) {
        const id = await svc.startConversation(topic, NOW);
        for (let t = 0; t < 4; t++) {
          const r = await svc.sendLearnerTurn(id, '我喜歡吃', { ...opts, learnerLevel: level }, NOW);
          total++;
          if (r.report.pass) passed++;
          else expect(r.npcTurn.glosses?.length ?? 0).toBeGreaterThan(0); // the rest show inline glosses
          if (r.npcTurn.validatorReport?.tiers?.usesUpcoming) upcomingTurns++;
        }
      }
      expect(total).toBe(20);
      expect(passed / total).toBeGreaterThanOrEqual(0.9);
      expect(upcomingTurns / total).toBeGreaterThanOrEqual(0.5);
    });
  }
});
