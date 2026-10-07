import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import { DEFAULT_STUDY_SETTINGS, getStudyFocus } from '../study/study-focus.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Word } from '../types.js';
import { OPEN_CHAT_CONFIG } from './openChat.config.js';
import {
  analyzeOpenChatText,
  buildOpenChatVocab,
  lessonThemeLabel,
  openChatChips,
  openChatFeedback,
  openChatGlosses,
  openChatHistoryWindow,
  openChatSummaryDue,
  openChatTierMix,
  pickBestOpenChatAttempt,
  summarizeOpenChat,
  upcomingContent,
  validateOpenChatTurn,
  type OpenChatProfile,
} from './openChat.js';

// ---- a small real-Chinese lexicon ------------------------------------------------
let n = 0;
const w = (
  headword: string,
  level: Level | null,
  glossEn: string,
  extra: Partial<Word> = {},
): Word => ({
  id: `w${++n}-${headword}`,
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
  tags: [],
  ...extra,
});

const WORDS: Record<string, Word> = Object.fromEntries(
  [
    w('我', 'N1', 'I'),
    w('你', 'N1', 'you'),
    w('喜歡', 'N1', 'to like'),
    w('吃', 'N1', 'to eat'),
    w('飯', 'N1', 'rice; meal'),
    w('喝', 'N1', 'to drink'),
    w('學校', 'N2', 'school'),
    w('朋友', 'N2', 'friend'),
    w('咖啡', 'L1', 'coffee'),
    w('週末', 'L1', 'weekend'),
    w('捷運', 'L2', 'MRT'),
    w('新聞', 'L3', 'news'),
    w('經濟', 'L4', 'economy'),
    w('政府', 'L4', 'government'),
    w('啊', null, 'ah', { tags: ['particle'] }),
    w('嗎', null, 'question particle', { tags: ['particle'] }),
    w('和', null, 'and', { tags: ['particle'] }),
    w('個', null, 'measure word', { tags: ['particle'] }),
    w('了', null, 'completed action', { tags: ['particle'] }),
    w('安安', null, 'An An', { tags: ['name'] }),
    w('醫生', 'L2', 'doctor'),
    w('老師', 'N1', 'teacher'),
    w('工作', 'L1', 'to work; job'),
    w('電影', 'L1', 'movie'),
  ].map((x) => [x.headword, x]),
);
const id = (hw: string) => WORDS[hw]!.id;
const lexicon = new Lexicon(Object.values(WORDS), [
  {
    id: 'gram-le',
    pattern: 'V + 了',
    level: 'N1',
    explanationEn: '',
    examples: [],
  },
]);

const lesson = (bookId: string, nn: number, over: Partial<Lesson> = {}): Lesson => ({
  id: `${bookId}-L${String(nn).padStart(2, '0')}`,
  n: nn,
  titleZh: '',
  titleEn: `Lesson ${nn}`,
  topic: `Topic ${bookId} ${nn} (I)`,
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
      lesson('laixue-1', 1, { topic: 'Occupations (I)', vocab: [id('老師'), id('安安')], properNouns: [id('安安')], grammar: ['gram-le'], supplementary: [id('醫生')] }),
      lesson('laixue-1', 2, { topic: 'Hobbies', vocab: [id('電影')] }),
      lesson('laixue-1', 3, { topic: 'Shopping', vocab: [id('咖啡')] }),
    ],
  },
  {
    id: 'laixue-2',
    titleZh: '',
    titleEn: '',
    lessons: [
      lesson('laixue-2', 1, { topic: 'Getting around', vocab: [id('捷運')] }),
      lesson('laixue-2', 2, { topic: 'Weather', vocab: [id('週末')] }),
    ],
  },
];

const card = (wordId: string, state: SkillCard['state'], stability = 30): SkillCard => ({
  item: { kind: 'word', id: wordId },
  skill: 'recognition',
  card: { ...createEmptyCard(new Date('2026-01-01')), stability },
  state,
  lapses: 0,
  leech: false,
  leechTreatmentsTried: [],
  clozeRung: 1,
  clozeStreak: 0,
  familiarity: 0,
  readingDependence: 0,
  flags: {},
  updatedAt: new Date('2026-01-01'),
});

const now = new Date('2026-10-07');
const none = new Set<string>();

function profile(over: Partial<OpenChatProfile> = {}): OpenChatProfile {
  return {
    lexicon,
    level: 'N1',
    knownIds: none,
    dueIds: none,
    learningIds: none,
    books,
    ...over,
  };
}

/** A real Phase 14 focus: book 1 lessons are N1, book 2 lessons are L1 (gated while N1 is unmastered). */
function focusFor(masteredWordIds: string[] = [], myClass?: OpenChatProfile['myClass']) {
  return getStudyFocus(
    {
      lexicon,
      books,
      cards: masteredWordIds.flatMap((x) => [
        { ...card(x, 'review', 30) },
        { ...card(x, 'review', 30), skill: 'production' as const },
      ]),
      grammarUses: new Map([['gram-le', { correct: 3, lastCorrect: true }]]),
      settings: { ...DEFAULT_STUDY_SETTINGS },
      ...(myClass ? { myClass } : {}),
    },
    now,
  );
}

const lessonIds = (u: ReturnType<typeof upcomingContent>) => u.lessons.map((l) => l.lessonId);

describe('upcomingContent: the next three lessons', () => {
  it('Phase 14 on: the active lesson plus the next two in study order', () => {
    const focus = focusFor();
    expect(focus.activeStep).toMatchObject({ kind: 'lesson', lessonId: 'laixue-1-L01' });
    const u = upcomingContent(profile({ studyFocus: focus }));
    expect(u.source).toBe('study-order');
    expect(lessonIds(u)).toEqual(['laixue-1-L01', 'laixue-1-L02', 'laixue-1-L03']);
    // core vocab and the grammar function words only: no proper noun, no supplementary word
    expect(u.wordIds).toContain(id('老師'));
    expect(u.wordIds).not.toContain(id('安安'));
    expect(u.wordIds).not.toContain(id('醫生'));
    expect(u.grammarIds).toEqual(['gram-le']);
  });

  it('Phase 14 gate: a lesson behind an unmastered TOCFL level does not count', () => {
    // Active = book 1 L3 (N1 still unmastered), so book 2's lessons (level L1) are gated.
    const mastered = [id('老師'), id('電影')];
    const focus = focusFor(mastered);
    expect(focus.activeStep).toMatchObject({ kind: 'lesson', lessonId: 'laixue-1-L03' });
    expect(focus.gatedLessonIds).toContain('laixue-2-L01');
    const u = upcomingContent(profile({ studyFocus: focus }));
    expect(lessonIds(u)).toEqual(['laixue-1-L03']);
    expect(u.wordIds).not.toContain(id('捷運'));
  });

  it('Phase 14: once the lower levels are mastered the next lessons open up', () => {
    const everyN = Object.values(WORDS).filter((x) => x.level === 'N1' || x.level === 'N2').map((x) => x.id);
    const focus = focusFor([...everyN, id('電影')]);
    expect(focus.gatedLessonIds ?? []).not.toContain('laixue-2-L01');
    const u = upcomingContent(profile({ studyFocus: focus }));
    expect(lessonIds(u)).toEqual(['laixue-1-L03', 'laixue-2-L01', 'laixue-2-L02']);
  });

  it('Phase 14 level step: that level’s unmastered words take the place of lessons', () => {
    const focus = focusFor();
    const levelStep = { ...focus, activeStep: { kind: 'level' as const, level: 'N1' as Level }, focusItems: [{ kind: 'word' as const, id: id('吃') }, { kind: 'grammar' as const, id: 'g' }, { kind: 'word' as const, id: id('飯') }] };
    const u = upcomingContent(profile({ studyFocus: levelStep }));
    expect(u).toMatchObject({ source: 'level-step', lessons: [], wordIds: [id('吃'), id('飯')] });
    expect(upcomingContent(profile({ studyFocus: levelStep }), { upcomingLessons: 3, levelStepWordCap: 1 }).wordIds).toEqual([id('吃')]);
  });

  it('"My class" only: the current lesson and the next two in course order', () => {
    const u = upcomingContent(
      profile({ myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 3 } }),
    );
    expect(u.source).toBe('my-class');
    expect(lessonIds(u)).toEqual(['laixue-1-L03', 'laixue-2-L01', 'laixue-2-L02']);
  });

  it('study order switched off falls back to My class', () => {
    const off = { ...focusFor(), enabled: false };
    const u = upcomingContent(
      profile({ studyFocus: off, myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 2 } }),
    );
    expect(lessonIds(u)).toEqual(['laixue-1-L02', 'laixue-1-L03', 'laixue-2-L01']);
  });

  it('no textbook (or My class off, no study order): nothing is upcoming', () => {
    expect(upcomingContent(profile({ books: [] })).source).toBe('none');
    expect(upcomingContent(profile()).source).toBe('none');
    expect(upcomingContent(profile({ myClass: { enabled: false, textbookId: 'laixue-1', currentLesson: 1 } })).wordIds).toEqual([]);
  });
});

describe('buildOpenChatVocab: the tiers', () => {
  const topic = { text: 'school', words: ['學校', '朋友', '新聞', '經濟', '政府', '火星人', '喜歡'] };

  it('known, due and learning words are tier A; the upcoming lessons’ core words too', () => {
    const v = buildOpenChatVocab(
      profile({
        knownIds: new Set([id('我')]),
        dueIds: new Set([id('你')]),
        learningIds: new Set([id('學校')]),
        myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 },
      }),
      topic,
      now,
    );
    for (const hw of ['我', '你', '學校', '老師', '電影', '咖啡']) expect(v.tierAIds.has(id(hw))).toBe(true);
    expect(v.tierAIds.has(id('醫生'))).toBe(false); // supplementary
    expect(v.tierAIds.has(id('捷運'))).toBe(false); // lesson 4, not in the next three
    expect(v.upcomingIds.has(id('老師'))).toBe(true);
    expect(v.grammar).toEqual(['V + 了']);
  });

  it('tier B is the picked level (and the ones below) minus tier A; everything else is C', () => {
    const base = profile({ knownIds: new Set([id('我')]) });
    const n1 = buildOpenChatVocab({ ...base, level: 'N1' }, topic, now);
    expect(n1.tierBIds.has(id('喜歡'))).toBe(true);
    expect(n1.tierBIds.has(id('我'))).toBe(false); // already A
    expect(n1.tierBIds.has(id('咖啡'))).toBe(false); // L1: not yet
    const l1 = buildOpenChatVocab({ ...base, level: 'L1' }, topic, now);
    expect(l1.tierBIds.has(id('咖啡'))).toBe(true);
    expect(l1.tierBIds.has(id('新聞'))).toBe(false);
    const strict = buildOpenChatVocab({ ...base, level: 'L1' }, topic, now, { ...OPEN_CHAT_CONFIG, tierBIncludesLowerLevels: false });
    expect(strict.tierBIds.has(id('喜歡'))).toBe(false);
    expect(strict.tierBIds.has(id('咖啡'))).toBe(true);
  });

  it('sorts the topic words into tiers; words outside the lexicon are tier C', () => {
    const v = buildOpenChatVocab(
      profile({ level: 'N2', knownIds: new Set([id('學校')]) }),
      topic,
      now,
    );
    expect(v.tiers.a.slice(0, 1)).toEqual(['學校']);
    expect(v.tiers.b).toEqual(expect.arrayContaining(['朋友', '喜歡']));
    expect(v.tiers.cAllowed).toEqual(['新聞', '經濟', '政府', '火星人']);
    expect(v.topicCounts).toEqual({ a: 1, b: 2, c: 4 });
    expect(v.hardTopic).toBe(false);
    expect(
      buildOpenChatVocab(profile({ level: 'N2' }), topic, now, { ...OPEN_CHAT_CONFIG, hardTopicTierCWords: 4 }).hardTopic,
    ).toBe(true);
  });

  it('caps tier C topic words at 5 and the A sample at 150, due and upcoming words first', () => {
    const many = Array.from({ length: 9 }, (_, i) => `詞${i}`);
    const v = buildOpenChatVocab(profile({ level: 'N1' }), { text: 'x', words: many }, now);
    expect(v.tiers.cAllowed).toHaveLength(5);

    const filler = Array.from({ length: 300 }, (_, i) => w(`填${i}`, 'N1', 'x'));
    const big = new Lexicon([...Object.values(WORDS), ...filler], []);
    const known = new Set(filler.map((f) => f.id));
    const v2 = buildOpenChatVocab(
      { ...profile({ level: 'N1', knownIds: known, dueIds: new Set([id('你')]), myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 } }), lexicon: big },
      { text: '' },
      now,
      OPEN_CHAT_CONFIG,
      () => 0.5,
    );
    expect(v2.tiers.a).toHaveLength(150);
    expect(v2.tiers.a[0]).toBe('你'); // due first
    expect(v2.tiers.a.slice(1, 3)).toEqual(expect.arrayContaining(['老師'])); // then upcoming
  });

  it('with no textbook, tier A is just the learner’s own words', () => {
    const v = buildOpenChatVocab(profile({ books: [], knownIds: new Set([id('我')]) }), { text: '' }, now);
    expect(v.upcoming.source).toBe('none');
    expect(v.tierAIds.has(id('老師'))).toBe(false);
  });
});

describe('analyze / validate an open-chat reply', () => {
  const vocab = buildOpenChatVocab(
    profile({
      level: 'N2',
      knownIds: new Set([id('我'), id('你'), id('喜歡'), id('吃'), id('飯'), id('喝')]),
      myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 },
    }),
    { text: 'school', words: ['學校', '新聞'] },
    now,
  );
  const ctx = { vocab, lexicon, upcomingIds: vocab.upcomingIds };

  it('passes a reply of tier A words; flags that it used an upcoming-lesson word', () => {
    const r = analyzeOpenChatText('你喜歡吃飯嗎？', ctx);
    expect(r.counts).toMatchObject({ a: 4, b: 0, c: 0 });
    expect(r.pass).toBe(true);
    const r2 = analyzeOpenChatText('你喜歡老師嗎？', ctx);
    expect(r2.usesUpcoming).toBe(true);
    expect(analyzeOpenChatText('你喜歡吃飯嗎？', ctx).usesUpcoming).toBe(false);
  });

  it('counts tier B and C, and fails when the limits are exceeded', () => {
    const okB = analyzeOpenChatText('你喜歡學校和朋友嗎？', ctx); // 學校/朋友 are N2 = tier B (2 ≤ 3)
    expect(okB.counts.b).toBe(2);
    expect(okB.failed).not.toContain('tierB');

    const manyC = analyzeOpenChatText('你喜歡新聞和經濟嗎？', ctx);
    expect(manyC.counts.c).toBe(2);
    expect(manyC.failed).toContain('tierC');
    expect(manyC.pass).toBe(false);

    const oneC = analyzeOpenChatText('你喜歡我吃新聞。', ctx);
    expect(oneC.failed).not.toContain('tierC');
  });

  it('tier A must be at least 85% of content tokens', () => {
    const l1 = buildOpenChatVocab(profile({ level: 'L1' }), { text: '' }, now);
    const r = analyzeOpenChatText('你喜歡學校朋友咖啡週末嗎？', { vocab: l1, lexicon });
    expect(r.counts.b).toBeGreaterThan(3);
    expect(r.failed).toEqual(expect.arrayContaining(['tierA', 'tierB']));
    // exactly the share: 6 A + 1 B = 85.7% passes, 5 A + 1 B = 83% fails
    const six = analyzeOpenChatText('你喜歡吃飯喝我學校', ctx);
    expect(six.shareA).toBeCloseTo(6 / 7);
    expect(six.failed).not.toContain('tierA');
    const five = analyzeOpenChatText('你喜歡吃飯喝學校', ctx);
    expect(five.shareA).toBeCloseTo(5 / 6);
    expect(five.failed).toContain('tierA');
  });

  it('names, particles, numbers, punctuation and the learner’s own words are not counted', () => {
    const r = analyzeOpenChatText('安安，你吃了 3 個新聞啊！', { ...ctx, typedTexts: new Set(['新聞']) });
    expect(r.tokens.find((t) => t.text === '新聞')?.tier).toBe('allowed');
    expect(r.tokens.find((t) => t.text === '安安')?.tier).toBe('allowed');
    expect(r.tokens.find((t) => t.text === '啊')?.tier).toBe('allowed');
    expect(r.counts.c).toBe(0);
    expect(r.counts.allowed).toBe(5); // 安安, 了, 個, 新聞 (typed), 啊
  });

  it('fails on simplified characters and mainland terms', () => {
    const r = analyzeOpenChatText('你喜欢吃饭吗？', ctx);
    expect(r.failed).toContain('taiwanness');
    expect(analyzeOpenChatText('你搭地鐵嗎？', ctx).failed).toContain('taiwanness');
  });

  it('an empty content reply (just 好！) counts as 100% tier A', () => {
    const r = analyzeOpenChatText('3！', ctx);
    expect(r.shareA).toBe(1);
    expect(r.pass).toBe(true);
  });

  it('validateOpenChatTurn uses the model’s own tokens as hints', () => {
    const r = validateOpenChatTurn(
      { reply_zh: '你喜歡吃飯嗎？', tokens: [{ text: '你' }, { text: '喜歡' }, { text: '吃' }, { text: '飯' }] },
      ctx,
    );
    expect(r.pass).toBe(true);
  });

  it('feedback names the offending words; the best attempt wins; glosses cover tier B/C', () => {
    const bad = analyzeOpenChatText('你喜歡新聞和經濟嗎？', ctx);
    const fb = openChatFeedback(bad);
    expect(fb).toContain('新聞');
    expect(fb).toContain('經濟');

    const worse = analyzeOpenChatText('你喜歡新聞和經濟和政府嗎？', ctx);
    const good = analyzeOpenChatText('你喜歡新聞嗎？', ctx);
    expect(pickBestOpenChatAttempt([{ report: worse }, { report: bad }, { report: good }]).report).toBe(good);
    expect(pickBestOpenChatAttempt([{ report: worse }, { report: bad }]).report).toBe(bad);

    expect(openChatGlosses(bad, lexicon)).toEqual([
      { text: '新聞', gloss: 'news' },
      { text: '經濟', gloss: 'economy' },
    ]);
  });
});

describe('chips', () => {
  const upcoming = upcomingContent(profile({ myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 } }));

  it('lesson themes first, then defaults that suit the level; up to 8', () => {
    const chips = openChatChips(upcoming, 'N1');
    expect(chips.slice(0, 3).map((c) => c.label)).toEqual(['Occupations', 'Hobbies', 'Shopping']);
    expect(chips.every((c) => c.source === 'lesson' || ['food', 'family', 'weekend', 'drinks', 'weather'].some((d) => c.id === `default:${d}`))).toBe(true);
    expect(chips.length).toBeLessThanOrEqual(8);
  });

  it('changing the level changes the chips (harder topics appear, none repeats)', () => {
    const n1 = openChatChips({ lessons: [] }, 'N1').map((c) => c.id);
    const l3 = openChatChips({ lessons: [] }, 'L3').map((c) => c.id);
    expect(n1).toHaveLength(5);
    expect(l3).toHaveLength(8);
    expect(new Set(l3).size).toBe(8);
    expect(l3).not.toEqual(n1);
    const l4 = openChatChips({ lessons: [] }, 'L4').map((c) => c.id);
    expect(l4).toEqual(expect.arrayContaining(['default:work', 'default:news']));
    expect(l4).not.toContain('default:food'); // the easiest ones make room
  });

  it('theme labels lose their (I)/(II) suffix', () => {
    expect(lessonThemeLabel('Occupations (I)')).toBe('Occupations');
    expect(lessonThemeLabel('Weather and seasons')).toBe('Weather and seasons');
  });
});

describe('long chats', () => {
  it('sends the last 12 turns; the older ones are covered by the summary', () => {
    const turns = Array.from({ length: 15 }, (_, i) => i);
    const { recent, dropped } = openChatHistoryWindow(turns);
    expect(recent).toHaveLength(12);
    expect(recent[0]).toBe(3);
    expect(dropped).toEqual([0, 1, 2]);
  });

  it('the summary is due once there is something to drop, then every 6 turns', () => {
    expect(openChatSummaryDue(12, 0)).toBe(false);
    expect(openChatSummaryDue(13, 0)).toBe(true);
    expect(openChatSummaryDue(15, 13)).toBe(false);
    expect(openChatSummaryDue(19, 13)).toBe(true);
  });

  it('summarizes locally and stays short', () => {
    const s = summarizeOpenChat(undefined, [
      { role: 'npc', zh: '你好！你今天怎麼樣？' },
      { role: 'learner', zh: '我很好。' },
    ]);
    expect(s).toBe('安安: 你好！你今天怎麼樣？ / Learner: 我很好。');
    const long = summarizeOpenChat(s, Array.from({ length: 200 }, () => ({ role: 'learner' as const, zh: '我喜歡吃飯和喝咖啡' })));
    expect(long.length).toBeLessThanOrEqual(OPEN_CHAT_CONFIG.history.summaryMaxChars);
  });

  it('tier mix over several turns', () => {
    expect(openChatTierMix([{ a: 9, b: 1, c: 0 }, { a: 8, b: 1, c: 1 }])).toEqual({ shareA: 17 / 20, turns: 2 });
    expect(openChatTierMix([])).toEqual({ shareA: 1, turns: 0 });
  });
});
