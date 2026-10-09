import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Lexicon,
  type Lesson,
  type LessonStory,
  type StoryLLM,
  type StoryRequest,
  type StoryResponse,
  type StudyFocus,
  type Textbook,
  type Word,
} from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { exportBackup } from '../db/backup.js';
import { mergeBackups } from '../db/merge.js';
import { FakeStoryLLM } from './fake-story-llm.js';

// The proxy's real cache and user message (Phase 26 acceptance: retries are never cache hits).
// Loaded at run time: the proxy is another package, outside this one's type-checked sources.
interface ProxyCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}
const PROXY_SRC = '../../../proxy/src/';
const proxyCache = (await import(/* @vite-ignore */ `${PROXY_SRC}cache.ts`)) as {
  PromptCache: { new <T>(): ProxyCache<T>; keyFor(system: string, user: string): string };
};
const PromptCache = proxyCache.PromptCache;
const { storyUserMessage } = (await import(/* @vite-ignore */ `${PROXY_SRC}prompt.ts`)) as {
  storyUserMessage(req: StoryRequest): string;
};
import { LearnerService } from './learner-service.js';
import { StoryService, StoryUnavailableError, type StoryEnvironment } from './story-service.js';

let db: AnanDB;
let learnerService: LearnerService;
beforeEach(() => {
  db = new AnanDB(`anan-story-${Math.random()}`);
  learnerService = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

let n = 0;
const w = (headword: string, level: Word['level'], glossEn: string, tags: string[] = []): Word => ({
  id: `st${++n}`,
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

const KNOWN = ['我', '你', '他', '喜歡', '吃', '飯', '喝', '茶', '很', '好', '去', '看', '今天', '朋友'].map((h) => w(h, 'N1', h));
const COFFEE = w('咖啡', 'N1', 'coffee'); // lesson 1 (active): rung 2
const STORE = w('便利商店', 'N1', 'convenience store'); // lesson 2: rung 3
const MRT = w('捷運', 'N1', 'MRT'); // lesson 3: rung 4
const ECON = w('經濟', 'L4', 'economy'); // rung 6
const PARTICLES = ['嗎', '了', '呢'].map((h) => w(h, null, h, ['particle']));
const lexicon = new Lexicon([...KNOWN, COFFEE, STORE, MRT, ECON, ...PARTICLES]);
const byHw = (h: string) => lexicon.lookup(h)[0]!;

const lesson = (nn: number, over: Partial<Lesson>): Lesson => ({
  id: `laixue-1-L0${nn}`,
  n: nn,
  titleZh: '',
  titleEn: `Lesson ${nn}`,
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
    lessons: [lesson(1, { vocab: [COFFEE.id] }), lesson(2, { vocab: [STORE.id] }), lesson(3, { vocab: [MRT.id] })],
  },
];
const step = { kind: 'lesson' as const, bookId: 'laixue-1', n: 1, lessonId: 'laixue-1-L01', level: 'N1' as const, ordinal: 1 };
const FOCUS: StudyFocus = {
  enabled: true,
  steps: [step],
  activeStep: step,
  activeLesson: step,
  reviewLessons: [],
  focusItems: [],
  reviewItems: [],
  newItemsAllowed: [],
  generalNewItemsAllowed: true,
  gateStatus: { blocked: false },
  mastery: undefined,
  nextStep: undefined,
  reached: 0,
  justMastered: [],
};
const env: StoryEnvironment = { books: () => books, studyFocus: async () => FOCUS };

const NOW = new Date('2026-10-08T10:00:00Z');

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

const service = (llm: FakeStoryLLM) => new StoryService(db, lexicon, learnerService, llm, env, () => 0.5);

/** A story made of the given text (questions from the default fake). */
const scripted =
  (...zh: string[]) =>
  (req: StoryRequest, i: number): StoryResponse => ({
    ...FakeStoryLLM.defaultStory(req),
    paragraphs: [{ zh: zh[Math.min(i, zh.length - 1)]!, en: 'x' }],
  });

const GOOD = '我今天去看朋友。朋友喜歡喝咖啡，我喜歡喝茶。他很好。你吃飯了嗎？你喜歡咖啡嗎？我很好。他去便利商店。我今天很好，你呢？朋友喝茶，我喝茶。我喜歡吃飯。';
const HARD = '經濟很好。經濟經濟。捷運便利商店咖啡。';

describe('StoryService (Phase 24)', () => {
  it('sends the ladder (rung 2–4 complete, rung 1 known), validates, has the other provider check it, and saves it', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM(scripted(GOOD));
    const s = service(llm);
    const story = await s.write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    const req = llm.writeCalls[0]!;
    expect(req.rungs.r2).toEqual(['咖啡']);
    expect(req.rungs.r3).toEqual(['便利商店']);
    expect(req.rungs.r4).toEqual(['捷運']);
    expect(req.rungs.r1).toContain('朋友');
    expect(req.topic).toContain('Theme 1');
    expect(req.length).toEqual({ min: 60, max: 120 });
    // Phase 26: rungs 1–2 also go grouped with glosses, this lesson first
    expect(req.groups?.[0]).toMatchObject({ label: 'this lesson', words: [{ zh: '咖啡', en: 'coffee' }] });
    // independent: the checker only sees the story, its summary and questions
    expect(Object.keys(llm.checkCalls[0]!).sort()).toEqual(['paragraphs', 'questions', 'summaryEn']);
    expect(story.lessonId).toBe('laixue-1-L01');
    expect(story.rung1Share).toBeGreaterThanOrEqual(0.9);
    expect(story.newWords.map((x) => x.text)).toEqual(['咖啡', '便利商店']);
    expect(await s.library()).toHaveLength(1);
  });

  it('the dev fake writer always produces a story the validator accepts', async () => {
    await seedKnown();
    const story = await service(new FakeStoryLLM()).write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    expect(story.questions.length).toBeGreaterThanOrEqual(2);
    const l1 = await service(new FakeStoryLLM()).write({ level: 'L1', difficulty: 'easier', kind: 'typed', text: 'tea' }, NOW);
    expect(l1.chars).toBeGreaterThanOrEqual(150 * 0.75);
  });

  it('the same request is never generated twice (concurrent asks share one call; Next story reuses a ready one)', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM(scripted(GOOD));
    const s = service(llm);
    const ask = { level: 'N1' as const, difficulty: 'middle' as const, kind: 'lesson' as const };
    const [a, b] = await Promise.all([s.write(ask, NOW), s.write(ask, NOW)]);
    expect(a.id).toBe(b.id);
    expect(llm.writeCalls).toHaveLength(1);
    const next = await s.next('N1', 'middle', NOW);
    expect(next.id).toBe(a.id);
    expect(llm.writeCalls).toHaveLength(1);
    // two ready in the background: one more is written, then nothing
    expect(await s.ensureReady('N1', 'middle', NOW)).toBe(2);
    expect(llm.writeCalls).toHaveLength(2);
    expect(await s.ensureReady('N1', 'middle', NOW)).toBe(2);
    expect(llm.writeCalls).toHaveLength(2);
  });

  it('mostly unknown words: rewritten with feedback (3 calls at most), then shows nothing', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM(scripted(HARD));
    const s = service(llm);
    await expect(s.write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW)).rejects.toBeInstanceOf(StoryUnavailableError);
    expect(llm.writeCalls.length + llm.repairCalls.length).toBe(3);
    expect(llm.writeCalls[1]!.feedback).toMatch(/經濟/);
    expect(llm.checkCalls).toHaveLength(0);
    expect(await s.library()).toHaveLength(0);
  });

  it('a regenerated story that passes is used', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM(scripted(HARD, GOOD));
    const story = await service(llm).write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    expect(llm.writeCalls).toHaveLength(2);
    expect(story.paragraphs[0]!.zh).toBe(GOOD);
  });

  it('Easier shows a story with a rung 4 word only as a mini lesson, the word explained (Phase 25/26)', async () => {
    await seedKnown();
    const withMrt = `${GOOD}他去捷運。`;
    const mid = await service(new FakeStoryLLM(scripted(withMrt))).write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    expect(mid).toBeTruthy();
    // a writer whose repair changes nothing: shown as a mini lesson, 捷運 explained
    const stuck = new FakeStoryLLM(scripted(withMrt), undefined, 'gemini', () => ({ sentences: [], paragraphsEn: [], newWords: [] }));
    const easy = await service(stuck).write({ level: 'N1', difficulty: 'easier', kind: 'typed', text: 'tea' }, NOW);
    expect(easy.glosses).toContainEqual({ zh: '捷運', en: 'MRT' });
    // Phase 26: the default repair swaps the word out: only that sentence changes
    const fixer = new FakeStoryLLM(scripted(withMrt));
    const fixed = await service(fixer).write({ level: 'N1', difficulty: 'easier', kind: 'typed', text: 'coffee' }, NOW);
    expect(fixer.repairCalls).toHaveLength(1);
    const asked = fixer.repairCalls[0]!.sentences.map((x) => x.zh);
    expect(asked).toContain('他去捷運。');
    expect(asked).not.toContain('我今天去看朋友。');
    expect(fixed.paragraphs[0]!.zh.startsWith('我今天去看朋友。朋友喜歡喝咖啡，我喜歡喝茶。')).toBe(true);
    expect(fixed.paragraphs[0]!.zh).not.toContain('捷運');
  });

  it('the independent reader can veto: unnatural, a wrong summary, or answers it disagrees with', async () => {
    await seedKnown();
    const ok = FakeStoryLLM.defaultCheck;
    const veto = new FakeStoryLLM(scripted(GOOD), (r) => ({ ...ok(r), summaryMatches: false, problems: ['summary is about something else'] }));
    await expect(service(veto).write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW)).rejects.toBeInstanceOf(StoryUnavailableError);
    expect(await db.stories.count()).toBe(0);
    // Phase 26 Part D: questions the reader disagrees with are dropped; the story still shows
    const twoRight = new FakeStoryLLM(scripted(GOOD), (r) => ({ ...ok(r), correctOptions: r.questions.map(() => [0, 1]) }));
    const noQ = await service(twoRight).write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    expect(noQ.questions).toEqual([]);
  });

  it('finishing: due/learning words read without a lookup give story_read_no_lookup; answers give no word evidence', async () => {
    await seedKnown();
    // Phase 29 Part B.11: read credit needs a card answered in the app that is learning or in this
    // session (an imported seed is neither); 喝 and 朋友 were missed just now, so they are learning.
    for (const h of ['喝', '朋友'])
      await learnerService.record({ item: { kind: 'word', id: byHw(h).id }, skill: 'recognition', kind: 'review_again', at: NOW }, NOW);
    const s = service(new FakeStoryLLM(scripted(GOOD)));
    const story = await s.write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    const before = await db.evidence.count();
    await s.recordLookup(byHw('朋友').id, 'chat_lookup_gloss', story.id, NOW);
    const { evidence, story: read } = await s.finish(story, { lookedUp: new Set([byHw('朋友').id]), right: 2, of: 2 }, NOW);
    const ev = (await db.evidence.toArray()).slice(before);
    expect(ev[0]).toMatchObject({ kind: 'chat_lookup_gloss', context: { source: 'story', refId: story.id } });
    const noLookup = ev.filter((e) => e.kind === 'story_read_no_lookup');
    expect(noLookup).toHaveLength(evidence);
    expect(evidence).toBeGreaterThan(0);
    expect(noLookup.map((e) => e.item.id)).not.toContain(byHw('朋友').id);
    // the rung 2 word has no card: no evidence for it; nothing for the answers
    expect(noLookup.map((e) => e.item.id)).not.toContain(COFFEE.id);
    expect(ev.every((e) => e.context?.source === 'story')).toBe(true);
    expect(read).toMatchObject({ score: { right: 2, of: 2 }, readCount: 1 });
    expect((await s.weekStats(NOW)).finished).toBe(1);
    expect((await s.weekStats(NOW)).chars).toBe(story.chars);
    expect(await s.readyFor('N1', NOW)).toHaveLength(0);
  });

  it('summary lists the new words; Add to review makes them New cards (sessions take them within the caps)', async () => {
    await seedKnown();
    const s = service(new FakeStoryLLM(scripted(GOOD)));
    const story = await s.write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    const sum = await s.summary(story, new Set());
    expect(sum.newWords.map((x) => [x.text, x.rung, x.inReview])).toEqual([
      ['咖啡', 2, false],
      ['便利商店', 3, false],
    ]);
    await s.addToReview([COFFEE.id], NOW);
    const card = await learnerService.getCard({ kind: 'word', id: COFFEE.id }, 'recognition');
    expect(card?.state).toBe('introduced');
    expect((await s.summary(story, new Set())).newWords[0]!.inReview).toBe(true);
  });

  it('Continue a story carries the characters and the previous summary, as a new episode', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM((req, i) => ({ ...scripted(`小美${GOOD}`)(req, i), characters: ['小美'] }));
    const s = service(llm);
    const first = await s.write({ level: 'N1', difficulty: 'middle', kind: 'chip', text: 'tea' }, NOW);
    const second = await s.write({ level: 'N1', difficulty: 'middle', kind: 'continue', continueFrom: first }, NOW);
    expect(llm.writeCalls[1]!.names).toContain('小美');
    expect(llm.writeCalls[1]!.previous?.summaryEn).toBe(first.summaryEn);
    expect(second).toMatchObject({ seriesId: first.id, episode: 2, topic: 'tea' });
  });

  it('the library syncs: two devices keep every story, and the later read wins', async () => {
    await seedKnown();
    const s = service(new FakeStoryLLM(scripted(GOOD)));
    const story = await s.write({ level: 'N1', difficulty: 'middle', kind: 'lesson' }, NOW);
    const local = await exportBackup(db);
    const later = new Date(NOW.getTime() + 60_000);
    const remote = {
      ...local,
      stories: [
        { ...story, readAt: later, updatedAt: later, readCount: 1 },
        { ...story, id: 'story-other', createdAt: later, updatedAt: later },
      ],
    };
    const merged = mergeBackups(local, remote);
    expect(merged.stories.map((x) => x.id).sort()).toEqual([story.id, 'story-other'].sort());
    expect(merged.stories.find((x) => x.id === story.id)?.readCount).toBe(1);
  });
});

describe('StoryService (Phase 26)', () => {
  /** A fake writer behind the proxy's real PromptCache, keyed like the proxy (task + user message). */
  function cachedLLM(make: (req: StoryRequest) => StoryResponse) {
    const cache = new PromptCache<{ story: StoryResponse }>();
    const log: Array<{ user: string; served: 'cache' | 'model' }> = [];
    const llm: StoryLLM = {
      async writeStory(req) {
        const user = storyUserMessage(req);
        const key = PromptCache.keyFor('/v1/story', user);
        const hit = req.fresh ? undefined : cache.get(key);
        log.push({ user, served: hit ? 'cache' : 'model' });
        if (hit) return hit;
        const res = { story: make(req) };
        cache.set(key, res);
        return res;
      },
      checkStory: async (r) => FakeStoryLLM.defaultCheck(r),
      repairStory: async () => ({ sentences: [], paragraphsEn: [], newWords: [] }),
    };
    return { llm, log };
  }

  it('retries differ: after a refusal, the next "Next story" sends a different request, not served from the cache', async () => {
    await seedKnown();
    const { llm, log } = cachedLLM((req) => scripted(HARD)(req, 0));
    const s = new StoryService(db, lexicon, learnerService, llm, env, () => 0.5);
    await expect(s.next('N1', 'middle', NOW)).rejects.toBeInstanceOf(StoryUnavailableError);
    const firstTry = log.length;
    await expect(s.next('N1', 'middle', NOW)).rejects.toBeInstanceOf(StoryUnavailableError);
    const second = log[firstTry]!;
    expect(second.user).not.toBe(log[0]!.user);
    expect(second.served).toBe('model');
    expect(log.every((x) => x.served === 'model')).toBe(true);
  });

  it('a retry rotates the topic among the lesson theme and lesson-related topics', async () => {
    await seedKnown();
    const withGoals: Textbook[] = [{ ...books[0]!, lessons: books[0]!.lessons.map((l) => ({ ...l, objectives: ['Order a drink', 'Pay at the counter'] })) }];
    const llm = new FakeStoryLLM(scripted(HARD));
    const s = new StoryService(db, lexicon, learnerService, llm, { ...env, books: () => withGoals }, () => 0.5);
    await expect(s.next('N1', 'middle', NOW)).rejects.toBeInstanceOf(StoryUnavailableError);
    const before = llm.writeCalls.length;
    await expect(s.next('N1', 'middle', NOW)).rejects.toBeInstanceOf(StoryUnavailableError);
    expect(llm.writeCalls[0]!.topic).toContain('Theme 1');
    expect(llm.writeCalls[before]!.topic).toContain('Order a drink');
    expect(llm.writeCalls[before]!.variant).toBe(1);
    expect(llm.writeCalls[before]!.fresh).toBe(true);
  });

  it('Next story opens a lesson story written ahead, with no model call', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM(scripted(GOOD));
    const ready: LessonStory = {
      id: 'laixue-1-L01-s1',
      bookId: 'laixue-1',
      lessonId: 'laixue-1-L01',
      level: 'N1',
      topic: 'Theme 1',
      story: {
        ...FakeStoryLLM.defaultStory({ rungs: { r1: ['我'], r2: [], r3: [], r4: [], r5: [] }, budget: { rung1Share: 0.95, rung3: 0, rung4: 0, rung5: 0 }, length: { min: 10, max: 20 }, topic: 't' } as unknown as StoryRequest),
        paragraphs: [{ zh: GOOD, en: 'x' }],
      },
    };
    const s = new StoryService(db, lexicon, learnerService, llm, { ...env, lessonStories: async () => [ready] }, () => 0.5);
    const story = await s.next('N1', 'middle', NOW);
    expect(story.id).toBe('lesson-laixue-1-L01-s1');
    expect(story.newWords.map((x) => x.text)).toContain('咖啡');
    expect(llm.writeCalls).toHaveLength(0);
    // read it: the next one is written live
    await s.finish(story, { lookedUp: new Set(), right: 0, of: 0 }, NOW);
    await s.next('N1', 'middle', NOW);
    expect(llm.writeCalls).toHaveLength(1);
  });

  it('background "ready ahead" pauses for an hour after 2 failures in a row', async () => {
    await seedKnown();
    const llm = new FakeStoryLLM(scripted(HARD));
    const s = service(llm);
    await s.ensureReady('N1', 'middle', NOW);
    await s.ensureReady('N1', 'middle', NOW);
    const calls = llm.writeCalls.length;
    await s.ensureReady('N1', 'middle', new Date(NOW.getTime() + 30 * 60_000));
    expect(llm.writeCalls).toHaveLength(calls);
    await s.ensureReady('N1', 'middle', new Date(NOW.getTime() + 61 * 60_000));
    expect(llm.writeCalls.length).toBeGreaterThan(calls);
  });
});
