// Phase 40 (owner, 2026-10-14): tutoring words get levels, topics and every face, and come first.
import { describe, expect, it } from 'vitest';
import { tutorPlots, type Plant } from '../game/garden.js';
import {
  charLevelIndex,
  displayLevel,
  displayLevelShort,
  estimateLevelFromChars,
  estimateWordLevel,
} from '../level-estimate.js';
import { Lexicon } from '../lexicon.js';
import { buildOpenChatVocab } from '../chat/openChat.js';
import { vocabLadder } from '../progress/vocabLadder.js';
import { storyPromptLists } from '../stories/index.js';
import { scenarioTopics, SCENARIO_TOPICS, topicTagsFor } from '../topics.js';
import type { Level } from '../levels.config.js';
import type { Word } from '../types.js';
import { recentTutorWordIds, withTutorExtras, type TutorLesson } from './session.js';

const word = (headword: string, level: Level | null, extra: Partial<Word> = {}): Word => ({
  id: `w-${headword}`,
  headword,
  variants: [],
  pos: ['N'],
  level,
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: headword,
  chars: [...headword],
  tags: [],
  ...extra,
});

describe('level estimates (Part A)', () => {
  const words = [word('早', 'N1'), word('晚', 'N1'), word('餐廳', 'L1'), word('警察', 'L2'), word('郵局', 'L1'), word('藥', 'L3')];
  const chars = charLevelIndex(words);

  it('a word takes its hardest character; three characters or more go one step up', () => {
    expect(estimateLevelFromChars('早餐', chars)).toBe('L1');
    expect(estimateLevelFromChars('晚餐', chars)).toBe('L1');
    expect(estimateLevelFromChars('藥局', chars)).toBe('L3');
    expect(estimateLevelFromChars('警察局', chars)).toBe('L3'); // L2 → one step up
    expect(estimateLevelFromChars('宵夜', chars)).toBeUndefined(); // 宵 has no level anywhere
  });

  it('TBCL comes before characters; an official level needs no estimate', () => {
    const tbcl = new Map<string, Level>([['早餐', 'N2']]);
    expect(estimateWordLevel({ headword: '早餐', level: null }, { tbcl, chars })).toEqual({ estimatedLevel: 'N2', levelSource: 'tbcl' });
    expect(estimateWordLevel({ headword: '晚餐', level: null }, { tbcl, chars })).toEqual({ estimatedLevel: 'L1', levelSource: 'chars' });
    expect(estimateWordLevel({ headword: '早', level: 'N1' }, { tbcl, chars })).toBeUndefined();
  });

  it('displays an estimate with ≈; the official level always wins', () => {
    expect(displayLevel({ level: null, estimatedLevel: 'L1' })).toBe('L1');
    expect(displayLevel({ level: 'N2', estimatedLevel: 'L1' })).toBe('N2');
    expect(displayLevelShort({ level: null, estimatedLevel: 'L1' })).toMatch(/^≈ /);
    expect(displayLevel({ level: null })).toBeNull();
  });

  it('estimates never feed other estimates (only official levels index characters)', () => {
    const idx = charLevelIndex([word('宵夜', null, { estimatedLevel: 'N1' })]);
    expect(idx.levelOf('宵')).toBeUndefined();
  });
});

describe('topics (Part C)', () => {
  it("the owner's class topics map to food, health and places", () => {
    expect(topicTagsFor({ zh: '食物與一日三餐', en: 'Food and three meals a day' })).toContain('food');
    expect(topicTagsFor({ zh: '健康與就醫', en: 'Health and seeing a doctor' })).toContain('health');
    expect(topicTagsFor({ zh: '地點與服務', en: 'Places and services' })).toContain('places');
    expect(topicTagsFor({ zh: '量子物理', en: 'Quantum physics' })).toEqual([]);
  });

  it('every built-in scenario has topics', () => {
    for (const id of Object.keys(SCENARIO_TOPICS)) expect(scenarioTopics(id).length).toBeGreaterThan(0);
  });

  it('scenarios with a matching topic take the class words as extras; the class scenario is left alone', () => {
    const lessons: TutorLesson[] = [
      { id: 'c1', date: '2026-10-13T07:00', wordIds: ['a', 'b'], grammarIds: [], topicTags: ['food'], headwords: ['宵夜', '義大利麵'] },
    ];
    const scenarios = [
      { id: 'night-market', vocabExtras: ['夜市'] },
      { id: 'youbike', vocabExtras: ['騎'] },
      { id: 'tutor-x', vocabExtras: [], tutor: { sessionId: 'c1' } },
    ] as never;
    const out = withTutorExtras(scenarios, lessons) as unknown as Array<{ id: string; vocabExtras: string[] }>;
    expect(out[0]!.vocabExtras).toEqual(['夜市', '宵夜', '義大利麵']);
    expect(out[1]!.vocabExtras).toEqual(['騎']);
    expect(out[2]!.vocabExtras).toEqual([]);
  });

  it('Garden "Tutoring only": one plot per class, newest first', () => {
    const plant = (wordId: string): Plant => ({ wordId, wilt: 'healthy' }) as unknown as Plant;
    const plots = tutorPlots([plant('a'), plant('b'), plant('z')], [
      { id: 'old', title: 'Carl · 6 Oct', date: '2026-10-06', wordIds: ['a'] },
      { id: 'new', title: 'Carl · 13 Oct', date: '2026-10-13', wordIds: ['a', 'b'] },
    ]);
    expect(plots.map((p) => [p.title, p.plants.map((x) => x.wordId)])).toEqual([['Carl · 13 Oct', ['a', 'b']]]);
    expect(plots[0]!.kind).toBe('tutor');
  });
});

describe('the latest classes lead chat and story targets (Part E.4)', () => {
  const words = ['宵夜', '點心', '早餐', '書'].map((h) => word(h, 'N1'));
  const lexicon = new Lexicon(words);
  const ids = (hs: string[]) => hs.map((h) => `w-${h}`);
  const lessons: TutorLesson[] = [
    { id: 'c-old', date: '2026-09-01', wordIds: ids(['書']), grammarIds: [] },
    { id: 'c-new', date: '2026-10-13', wordIds: ids(['宵夜', '點心']), grammarIds: [] },
  ];

  it('recent tutoring words are rung 2 and lead open chat targets, with or without a textbook', () => {
    const tutorWordIds = recentTutorWordIds(lessons, 1);
    expect(tutorWordIds).toEqual(ids(['宵夜', '點心']));
    const profile = {
      lexicon,
      level: 'N1' as const,
      knownIds: new Set<string>(),
      dueIds: new Set<string>(),
      learningIds: new Set<string>(),
      books: [],
      tutorWordIds,
    };
    expect(vocabLadder(profile).rung('w-宵夜')).toBe(2);
    const v = buildOpenChatVocab(profile, { text: '' }, new Date('2026-10-14T12:00:00Z'));
    for (const id of tutorWordIds) expect(v.upcomingIds.has(id)).toBe(true);
  });

  it("the story's word list puts the class's words first", () => {
    const ladder = vocabLadder({
      lexicon,
      level: 'N1',
      knownIds: new Set(ids(['宵夜', '點心', '早餐', '書'])),
      dueIds: new Set(),
      learningIds: new Set(),
      books: [],
    });
    const lists = storyPromptLists({ lexicon, ladder, priorityIds: ids(['點心']), rng: () => 0.99 });
    expect(lists.rungs.r1[0]).toBe('點心');
  });
});
