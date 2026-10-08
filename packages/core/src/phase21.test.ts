import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { isUsableSentence } from './cloze/report.js';
import { glossFor } from './gloss/context.js';
import { charsInWord, readingMatchesDictionary } from './learner/leech.js';
import type { SkillCard } from './learner/types.js';
import { Lexicon } from './lexicon.js';
import { pickNewForSession } from './study/queue.js';
import type { StudyFocus } from './study/study-focus.js';
import type { Sense, Word } from './types.js';

/** Phase 21 shared helpers: one "new" rule, one sentence filter, one gloss, checked readings. */

const word = (id: string, headword: string, pinyin: string, pinyinNumeric: string, glossEn: string, extra: Partial<Word> = {}): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin,
  pinyinNumeric,
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags: [],
  ...extra,
});

const lexicon = new Lexicon([
  word('w-hai2', '還', 'hái', 'hai2', 'still'),
  word('w-huan2', '還', 'huán', 'huan2', 'to return'),
  word('w-jie2', '捷', 'jié', 'jie2', 'quick'),
  word('w-yun4', '運', 'yùn', 'yun4', 'to transport'),
  word('w-jieyun', '捷運', 'jié yùn', 'jie2 yun4', 'MRT'),
  word('w-ji1', '機', 'jī', 'ji1', 'machine'),
  word('w-che1', '車', 'chē', 'che1', 'vehicle'),
]);

describe('readingMatchesDictionary (AI "Define" readings, #67)', () => {
  it('accepts a reading built from MOE readings of each character', () => {
    expect(readingMatchesDictionary('捷運', 'jié yùn', lexicon)).toBe(true);
    expect(readingMatchesDictionary('還', 'hái', lexicon)).toBe(true);
    expect(readingMatchesDictionary('還', 'huán', lexicon)).toBe(true);
  });
  it('rejects a wrong tone or a mainland-style misreading', () => {
    expect(readingMatchesDictionary('捷運', 'jiē yùn', lexicon)).toBe(false);
    expect(readingMatchesDictionary('機車', 'jí chē', lexicon)).toBe(false);
  });
  it("can't tell when a character is unknown or syllables don't line up", () => {
    expect(readingMatchesDictionary('便利', 'biàn lì', lexicon)).toBeUndefined();
    expect(readingMatchesDictionary('捷運', 'jiéyùn', lexicon)).toBeUndefined();
  });
});

describe('charsInWord (leech breakdown uses the matching reading, #67)', () => {
  it('picks the per-character sense whose reading matches the word, not words[0]', () => {
    const huanqian = word('w-huanqian', '還車', 'huán chē', 'huan2 che1', 'return a car');
    const parts = charsInWord(huanqian, lexicon);
    expect(parts.map((p) => p.glossEn)).toEqual(['to return', 'vehicle']);
    expect(parts.map((p) => p.pinyin)).toEqual(['huán', 'chē']);
  });
});

describe('glossFor (one meaning rule, #64)', () => {
  const sense = (id: string, glossEn: string, pos: string): Sense => ({ id, glossEn, pos, basedOn: ['cedict'] });
  const jiche = {
    glossEn: 'scooter',
    primarySenseId: 's1',
    textbookSenseId: 's2',
    senses: [sense('s1', 'scooter; motorcycle', 'N'), sense('s2', 'annoying', 'Vs')],
  };
  it('textbook content uses the book sense; plain text uses the resolved sense', () => {
    expect(glossFor(jiche, { textbook: true })).toBe('annoying');
    expect(glossFor(jiche, { textbook: false })).toBe('scooter; motorcycle');
    expect(glossFor(jiche, { textbook: false, prev: '很' })).toBe('annoying');
  });
  it('an item on its own shows the sense it was learned with', () => {
    expect(glossFor(jiche)).toBe('annoying');
    expect(glossFor({ ...jiche, textbookSenseId: undefined })).toBe('scooter; motorcycle');
  });
  it("a model's valid sense id wins over the book sense when not textbook content", () => {
    expect(glossFor(jiche, { senseId: 's1' })).toBe('scooter; motorcycle');
  });
});

describe('isUsableSentence (report exclusions everywhere, #44)', () => {
  it('drops reported sentences (trimmed too) and keeps the rest', () => {
    const excluded = new Set(['我要搭捷運。']);
    expect(isUsableSentence('我要搭捷運。', excluded)).toBe(false);
    expect(isUsableSentence('  我要搭捷運。  ', excluded)).toBe(false);
    expect(isUsableSentence('我騎機車。', excluded)).toBe(true);
    expect(isUsableSentence('我騎機車。', undefined)).toBe(true);
  });
});

describe('pickNewForSession (one "new" rule, #40)', () => {
  const card = (id: string, skill: 'recognition' | 'production', over: Partial<SkillCard> = {}): SkillCard => ({
    item: { kind: 'word', id },
    skill,
    card: createEmptyCard(new Date('2026-10-01')),
    state: 'introduced',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: new Date('2026-10-01'),
    ...over,
  });
  const reviewed = { ...createEmptyCard(new Date('2026-10-01')), reps: 2 };
  const newCards = [
    card('other', 'recognition'),
    card('lesson-a', 'production'),
    card('lesson-a', 'recognition'),
    card('done', 'recognition', { card: reviewed }),
  ];
  const focus = {
    enabled: true,
    activeStep: { kind: 'lesson', bookId: 'laixue-1', lessonId: 'laixue-1-L01', n: 1, level: 'N1' },
    reviewLessons: [],
    newItemsAllowed: [
      { kind: 'word', id: 'lesson-a' },
      { kind: 'word', id: 'lesson-b' },
      { kind: 'word', id: 'lesson-c' },
    ],
  } as unknown as StudyFocus;
  const lessonIdx = new Map([
    ['word:lesson-a', 'laixue-1-L01'],
    ['word:lesson-b', 'laixue-1-L01'],
    ['word:lesson-c', 'laixue-1-L01'],
  ]);

  it('never counts an answered card as new and respects the allowance', () => {
    const out = pickNewForSession({ newCards, allowed: 10 });
    expect(out.cards.map((c) => c.item.id)).not.toContain('done');
    expect(pickNewForSession({ newCards, allowed: 0 })).toEqual({ cards: [], items: [] });
  });

  it('active-lesson cards first (recognition before production), then items with no card, capped', () => {
    const out = pickNewForSession({ newCards, focus, lessonIdx, allowed: 4 });
    expect(out.cards.map((c) => `${c.item.id}/${c.skill}`)).toEqual([
      'lesson-a/recognition',
      'lesson-a/production',
      'other/recognition',
    ]);
    // lesson-a already has cards, so the next introduced item is lesson-b, and the cap stops there
    expect(out.items.map((i) => i.id)).toEqual(['lesson-b']);
  });

  it('onlyItems limits both cards and introductions (a lesson step)', () => {
    const out = pickNewForSession({
      newCards,
      focus,
      lessonIdx,
      allowed: 10,
      onlyItems: new Set(['word:lesson-a', 'word:lesson-c']),
    });
    expect(out.cards.every((c) => c.item.id === 'lesson-a')).toBe(true);
    expect(out.items.map((i) => i.id)).toEqual(['lesson-c']);
  });
});
