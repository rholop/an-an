// Phase 36 Part E: the owner's conversation (明文 asks about your parents' jobs, 2026-10-10) as a
// fixture, run through scenario chat AND open chat with a fake model and a fake corrector. Both
// modes must give the same correction, gap options, facts and word panel.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Lexicon,
  type JournalReview,
  type JournalReviewRequest,
  type OpenTurnRequest,
  type Scenario,
  type TurnRequest,
  type TurnResponse,
  type Word,
} from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { ChatService } from './chat-service.js';
import { FakeTutorLLM, type FakeJournalScript } from './fake-tutor-llm.js';
import { LearnerService } from './learner-service.js';
import { OpenChatService } from './open-chat-service.js';
import type { ChatEngine } from './chat-engine.js';

let db: AnanDB;
let learnerService: LearnerService;

beforeEach(() => {
  db = new AnanDB(`anan-listen-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

function word(id: string, headword: string, glossEn: string, level: Word['level'] = 'N1'): Word {
  return {
    id,
    headword,
    variants: [],
    pos: ['N'],
    level,
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn,
    chars: [...headword],
    tags: [],
  };
}

const WORDS = [
  word('w-wo', '我', 'I'),
  word('w-ni', '你', 'you'),
  word('w-baba', '爸爸', 'dad'),
  word('w-mama', '媽媽', 'mom'),
  word('w-zai', '在', 'at'),
  word('w-xuexiao', '學校', 'school'),
  word('w-gongzuo', '工作', 'to work'),
  word('w-han', '含', 'to contain', 'L3'),
  word('w-he', '和', 'and'),
  word('w-bu', '不', 'not'),
  word('w-meitian', '每天', 'every day'),
  word('w-hen', '很', 'very'),
  word('w-mang', '忙', 'busy'),
  word('w-xihuan', '喜歡', 'to like'),
  word('w-zhonghua', '種花', 'to grow flowers; gardening', 'L2'),
  word('w-yuanyi', '園藝', 'gardening', 'L4'),
  word('w-jiaoshu', '教書', 'to teach', 'L1'),
  word('w-jia', '家', 'home'),
  word('w-ma', '嗎', 'question particle'),
  word('w-zhen', '真', 'really'),
  word('w-hao', '好', 'good'),
];
const lexicon = new Lexicon(WORDS);

const scenario: Scenario = {
  id: 'laixue-1-L04-jobs',
  title: "明文 asks about your parents' jobs",
  levelRange: { min: 'N1', max: 'L1' },
  npc: { id: 'mingwen', name: '明文', personality: 'friendly', speechStyle: 'short', particles: [] },
  setting: 'Two classmates talk about their families.',
  goalSteps: [{ id: 'jobs', description: 'Say what your parents do', keywordHints: [] }],
  vocabExtras: [],
  opener: { zh: '你爸爸媽媽做什麼工作？', en: 'What do your parents do?' },
  successLine: { zh: '謝謝！', en: 'Thanks!' },
};

const TYPO = '我爸爸在學校工作含我媽媽不工作。';
const GAP = '我爸爸每天很忙。我媽媽喜歡【gardening】。';

const reply = (zh: string, en: string, extra: Partial<TurnResponse> = {}): TurnResponse => ({
  reply_zh: zh,
  reply_en: en,
  tokens: [],
  targets_used: [],
  suggested_replies: [],
  goal_progress: [],
  ...extra,
});

/** The fake model: the same replies whichever chat asks. The first answer to the gap message
 * goes against the facts (你媽媽喜歡教書), as in the owner's screenshot. */
function fakeModel(req: { history: { role: string; zh: string }[]; feedback?: string; facts?: string[] }): TurnResponse {
  const last = [...req.history].reverse().find((t) => t.role === 'learner')?.zh ?? '';
  if (last === TYPO)
    return reply('你爸爸在學校工作，你媽媽在家嗎？', 'Your dad works at a school. Is your mom at home?', {
      learner_meaning_en: "My dad works at a school, and my mom doesn't work.",
      learner_facts: ['father: works at a school', "mother: doesn't work"],
    });
  if (last === GAP) {
    if (req.feedback?.includes('contradicts'))
      return reply('你媽媽喜歡種花，真好！', 'Your mom likes gardening, how nice!', {
        learner_meaning_en: 'My dad is busy every day. My mom likes gardening.',
        learner_facts: ['father: busy every day', 'mother: likes gardening'],
        kept_words: ['種花'],
      });
    return reply('你媽媽喜歡教書。', 'Your mom likes teaching.', {
      learner_meaning_en: 'My dad is busy every day. My mom likes gardening.',
      learner_facts: ['father: busy every day', 'mother: likes gardening'],
    });
  }
  return reply('好。', 'OK.');
}

/** The fake corrector: 含 typed for 和. */
const corrector: FakeJournalScript = {
  review: (req: JournalReviewRequest): JournalReview => {
    const at = req.text.indexOf('含');
    return {
      issues:
        at >= 0
          ? [
              {
                span: [at, at + 1],
                type: 'error',
                correction: '和',
                explanationEn: '含 means "contain"; "and" is 和.',
                confidence: 'high',
                explain: {
                  wrongEn: '含 (hán) means "to contain", not "and".',
                  fixEn: '和 (hé) joins two things or people: 我爸爸和我媽媽.',
                  exampleWrong: '我含你',
                  exampleRight: '我和你',
                },
                meaningEn: "My dad works at a school, and my mom doesn't work.",
              },
            ]
          : [],
      natural_rewrite: req.text.replace('含', '，'),
      brackets: [],
      used_well: [],
      sentences: [],
    };
  },
  gap: (req) => ({
    options: [
      { zh: '種花', pinyin: 'zhòng huā', meaningEn: 'grow flowers', usageEn: 'Everyday word for gardening.', corrected: req.sentence.replace('＿＿', '種花') },
      { zh: '園藝', pinyin: 'yuán yì', meaningEn: 'gardening', usageEn: 'More formal: the hobby or craft.', corrected: req.sentence.replace('＿＿', '園藝') },
    ],
  }),
};

const options = { learnerLevel: 'N2' as const, scaffolding: 'high' as const, englishFallback: false, showCorrections: true };

interface Mode {
  name: string;
  engine: ChatEngine;
  llm: FakeTutorLLM;
  start(): Promise<number>;
  send(cid: number, text: string): Promise<{ corrections?: Promise<void>; misunderstood?: boolean; attempts: number }>;
  turns(cid: number): Promise<import('../db/schema.js').TurnRow[]>;
  /** What the model was asked, in order. */
  requests: Array<{ facts?: string[]; feedback?: string }>;
}

function scenarioMode(quotaShort = async () => false): Mode {
  const requests: Mode['requests'] = [];
  const llm = new FakeTutorLLM((req: TurnRequest) => {
    requests.push(req);
    return fakeModel(req);
  }, corrector);
  const service = new ChatService(db, lexicon, learnerService, llm, undefined, () => 0.5, undefined, undefined, undefined, { quotaShort });
  return {
    name: 'scenario chat',
    engine: service.engine,
    llm,
    requests,
    start: () => service.startConversation(scenario),
    send: (cid, text) => service.sendLearnerTurn(cid, scenario, text, options),
    turns: (cid) => service.getTurns(cid),
  };
}

function openMode(quotaShort = async () => false): Mode {
  const requests: Mode['requests'] = [];
  const llm = new FakeTutorLLM(
    FakeTutorLLM.defaultScript,
    corrector,
    FakeTutorLLM.defaultSentences,
    (req: OpenTurnRequest) => {
      requests.push(req);
      return fakeModel(req);
    },
  );
  const service = new OpenChatService(db, lexicon, learnerService, llm, { books: () => [] }, undefined, () => 0.5, { quotaShort });
  return {
    name: 'open chat',
    engine: service.engine,
    llm,
    requests,
    start: () => service.startConversation('family'),
    send: (cid, text) => service.sendLearnerTurn(cid, text, options),
    turns: (cid) => service.getTurns(cid),
  };
}

/** What a mode's run of the owner's conversation produced, in comparable form. */
async function runOwnerConversation(mode: Mode) {
  const cid = await mode.start();
  const one = await mode.send(cid, TYPO);
  await one.corrections;
  const two = await mode.send(cid, GAP);
  await two.corrections;
  const turns = await mode.turns(cid);
  const learner = turns.filter((t) => t.role === 'learner');
  const entryId = learner[0]!.correction?.entryId;
  const review = entryId ? await mode.engine.journal.getReview(entryId) : undefined;
  const panel = await mode.engine.wordPanel(cid);
  return {
    cid,
    two,
    turns,
    learner,
    review,
    facts: await mode.engine.facts(cid),
    panel: panel.map((e) => ({ zh: e.zh, sources: [...e.sources].sort(), inReview: e.inReview })).sort((a, b) => a.zh.localeCompare(b.zh)),
  };
}

describe.each([
  ['scenario chat', scenarioMode],
  ['open chat', openMode],
] as const)("the owner's conversation in %s", (_name, makeMode) => {
  it('含 is corrected to 和, with a checked "Why?"', async () => {
    const out = await runOwnerConversation(makeMode());
    expect(out.learner[0]!.correction?.status).toBe('issues');
    const issue = out.review!.issues[0]!;
    expect(issue.correction).toBe('和');
    expect(issue.explain?.wrongEn).toContain('含');
    expect(issue.explainStatus).not.toBe('unsure');
    // the second message has nothing to fix: a small ✓
    expect(out.learner[1]!.correction?.status).toBe('clean');
  });

  it('the message is read correctly ("Read as") and the facts list holds the mother\'s facts', async () => {
    const out = await runOwnerConversation(makeMode());
    expect(out.learner[0]!.meaningEn).toBe("My dad works at a school, and my mom doesn't work.");
    expect(out.facts).toContain("mother: doesn't work; likes gardening");
    expect(out.facts).toContain('father: works at a school; busy every day');
  });

  it('【gardening】 offers 種花 / 園藝, each with Add to review, and nothing is added without a tap', async () => {
    const mode = makeMode();
    const out = await runOwnerConversation(mode);
    const gap = out.learner[1]!.gaps?.[0];
    expect(gap?.en).toBe('gardening');
    expect(gap?.options?.map((o) => o.zh)).toEqual(['種花', '園藝']);
    expect(gap?.added ?? []).toEqual([]);
    expect(out.panel.find((e) => e.zh === '種花')?.inReview).toBe(false);

    await mode.engine.addGapWord(out.learner[1]!.id!, 'gardening', '種花');
    const after = await mode.engine.wordPanel(out.cid);
    expect(after.find((e) => e.zh === '種花')?.inReview).toBe(true);
    expect(after.find((e) => e.zh === '園藝')?.inReview).toBe(false);
  });

  it('a reply saying 你媽媽喜歡教書 is caught as contradicting the facts and regenerated', async () => {
    const out = await runOwnerConversation(makeMode());
    const replies = out.turns.filter((t) => t.role === 'npc');
    expect(replies.at(-1)!.zh).toBe('你媽媽喜歡種花，真好！');
    expect(replies.some((t) => t.zh.includes('教書'))).toBe(false);
    expect(out.two.misunderstood).toBe(false);
    // the kept word is glossed, not auto-added
    expect(replies.at(-1)!.glosses?.map((g) => g.text)).toContain('種花');
  });

  it('the typo 含 is never auto-added; 和 reaches the word panel through the correction', async () => {
    const out = await runOwnerConversation(makeMode());
    expect(out.panel.find((e) => e.zh === '含')).toBeUndefined();
    expect(out.panel.find((e) => e.zh === '和')?.sources).toEqual(['corrected']);
    const hanCard = await learnerService.getCard({ kind: 'word', id: 'w-han' }, 'recognition');
    expect(hanCard).toBeUndefined();
  });

  it('the turn sent to the model carries the facts; the redo names the contradiction and asks to keep the meaning', async () => {
    const mode = makeMode();
    await runOwnerConversation(mode);
    const last = mode.requests.at(-1)!;
    expect(last.facts).toEqual(['father: works at a school', "mother: doesn't work"]);
    expect(last.feedback).toContain('contradicts');
    expect(last.feedback).toContain('Keep the same meaning');
  });

  it('with the journal chain short of quota, chat still replies and shows "Corrections paused"', async () => {
    const mode = makeMode(async () => true);
    const cid = await mode.start();
    const out = await mode.send(cid, TYPO);
    await out.corrections;
    const turns = await mode.turns(cid);
    expect(turns.at(-1)!.role).toBe('npc');
    expect(turns.find((t) => t.role === 'learner')!.correction?.status).toBe('paused');
    expect(mode.llm.journalCalls.review).toBe(0);
  });

  it('a corrected message reaches the error bank and evidence when the next one is sent', async () => {
    const mode = makeMode();
    const out = await runOwnerConversation(mode);
    await mode.engine.finishCorrections(out.cid);
    const entryId = out.learner[0]!.correction!.entryId!;
    expect((await mode.engine.journal.getEntry(entryId))?.status).toBe('finished');
    expect((await mode.engine.journal.getEntry(entryId))?.source).toBe('chat');
  });

});

describe('same behaviour in both chat modes', () => {
  it('the same messages give the same correction, gaps, facts and word panel', async () => {
    const a = await runOwnerConversation(scenarioMode());
    const b = await runOwnerConversation(openMode());
    const pick = (o: Awaited<ReturnType<typeof runOwnerConversation>>) => ({
      corrections: o.learner.map((t) => t.correction?.status),
      issues: o.review?.issues.map((i) => [i.span, i.correction, i.type]),
      gaps: o.learner.map((t) => t.gaps?.map((g) => [g.en, g.options?.map((x) => x.zh)])),
      meanings: o.learner.map((t) => t.meaningEn),
      facts: o.facts,
      panel: o.panel,
      lastReply: o.turns.at(-1)?.zh,
    });
    expect(pick(a)).toEqual(pick(b));
  });
});

describe('Try again and What did you mean? (both modes)', () => {
  it('scenario chat: Try again replaces the reply, and a fixed meaning is sent to the model', async () => {
    const llm = new FakeTutorLLM((req: TurnRequest) => fakeModel(req), corrector);
    const service = new ChatService(db, lexicon, learnerService, llm, undefined, () => 0.5, undefined, undefined, undefined, {
      quotaShort: async () => false,
    });
    const cid = await service.startConversation(scenario);
    await (await service.sendLearnerTurn(cid, scenario, TYPO, options)).corrections;
    await service.tryAgain(cid, scenario, options);
    let turns = await service.getTurns(cid);
    expect(turns.map((t) => t.role)).toEqual(['npc', 'learner', 'npc']);
    expect(await db.turns.filter((t) => t.replaced === true).count()).toBe(1);

    const learner = turns[1]!;
    const seen: TurnRequest[] = [];
    const spy = new FakeTutorLLM((req: TurnRequest) => {
      seen.push(req);
      return fakeModel(req);
    }, corrector);
    const service2 = new ChatService(db, lexicon, learnerService, spy, undefined, () => 0.5, undefined, undefined, undefined, {
      quotaShort: async () => false,
    });
    await service2.fixMeaning(cid, learner.id!, 'My dad works at a school and my mom stays home.', scenario, options);
    turns = await service2.getTurns(cid);
    expect(turns[1]!.meaningEn).toBe('My dad works at a school and my mom stays home.');
    expect(turns[1]!.meaningFixed).toBe(true);
    expect(seen.at(-1)!.learnerMeaningEn).toBe('My dad works at a school and my mom stays home.');
    expect(turns.map((t) => t.role)).toEqual(['npc', 'learner', 'npc']);
  });

  it('open chat: a reply that keeps contradicting is shown with the warning, and Try again is offered', async () => {
    const llm = new FakeTutorLLM(FakeTutorLLM.defaultScript, corrector, FakeTutorLLM.defaultSentences, () =>
      reply('你媽媽喜歡教書。', 'Your mom likes teaching.', { learner_facts: ["mother: doesn't work"] }),
    );
    const service = new OpenChatService(db, lexicon, learnerService, llm, { books: () => [] }, undefined, () => 0.5, {
      quotaShort: async () => false,
    });
    const cid = await service.startConversation('family');
    const out = await service.sendLearnerTurn(cid, '我媽媽不工作。', options);
    expect(out.misunderstood).toBe(true);
    expect(out.npcTurn.misunderstood).toBe(true);
    await service.tryAgain(cid, options);
    expect((await service.getTurns(cid)).filter((t) => t.role === 'npc')).toHaveLength(2);
  });
});
