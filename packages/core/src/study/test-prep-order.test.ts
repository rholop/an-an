// Phase 49 Part A: with TOCFL test prep on, the test words no lesson teaches come ahead of a lesson
// above the target; tutoring words stay first; with prep off the order is unchanged.
import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import type { Course } from '../textbook/course.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Word } from '../types.js';
import { pickNewForSession } from './queue.js';
import { DEFAULT_STUDY_SETTINGS, getStudyFocus, type StudyProfile } from './study-focus.js';

const word = (id: string, level: Level, rank: number): Word => ({
  id,
  headword: id,
  variants: [],
  pos: ['N'],
  level,
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [id],
  tags: [],
  freqRank: rank,
});
const lesson = (bookId: string, n: number, vocab: string[]): Lesson => ({
  id: `${bookId}-L${String(n).padStart(2, '0')}`,
  n,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab,
  supplementary: [],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
});
// One N1 book and one L3 book (the class is on the L3 book).
const course: Course = {
  id: 'c',
  titleZh: '課',
  titleEn: 'Course',
  books: [
    { id: 'b1', titleZh: '一', titleEn: 'One', lessons: 1, levelLabel: 'pre-A1', level: 'N1' },
    { id: 'b3', titleZh: '三', titleEn: 'Three', lessons: 1, levelLabel: 'B1', level: 'L3' },
  ],
};
const books: Textbook[] = [
  { id: 'b1', titleZh: '', titleEn: '', lessons: [lesson('b1', 1, ['b1-a', 'b1-b'])] },
  { id: 'b3', titleZh: '', titleEn: '', lessons: [lesson('b3', 1, ['b3-a', 'b3-b'])] },
];
const LEVELS: Level[] = ['N1', 'N2', 'L1', 'L2', 'L3'];
const rest = (lv: Level) => Array.from({ length: 10 }, (_, i) => `${lv}-${i}`);
const lexicon = new Lexicon([
  ...LEVELS.flatMap((lv) => rest(lv).map((id, i) => word(id, lv, i + 1))),
  word('b1-a', 'N1', 1),
  word('b1-b', 'N1', 2),
  word('b3-a', 'L3', 1),
  word('b3-b', 'L3', 2),
]);
const card = (id: string, skill: 'recognition' | 'production', stability: number): SkillCard => ({
  item: { kind: 'word', id },
  skill,
  card: { ...createEmptyCard(new Date('2026-01-01')), stability },
  state: 'review',
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
const mastered = (ids: string[]) => ids.flatMap((id) => [card(id, 'recognition', 30), card(id, 'production', 10)]);
// Everything below L3 is mastered at the 90% line, but one word of each level (its 10th) is not met:
// those are the test words still to learn. The L3 lesson is the active one.
const cards = mastered(['b1-a', 'b1-b', ...(['N1', 'N2', 'L1', 'L2'] as Level[]).flatMap((lv) => rest(lv).slice(0, 9))]);

function profile(testPrep?: StudyProfile['settings']['testPrep'], extra: Partial<StudyProfile> = {}): StudyProfile {
  return {
    lexicon,
    books,
    course,
    cards,
    grammarUses: new Map(),
    myClass: { enabled: true, textbookId: 'b3', currentLesson: 1 },
    settings: { ...DEFAULT_STUDY_SETTINGS, ...(testPrep ? { testPrep } : {}) },
    ...extra,
  };
}
const now = new Date('2026-10-20T12:00:00Z');
const ids = (f: ReturnType<typeof getStudyFocus>) => f.newItemsAllowed.map((i) => i.id);

describe('Phase 49: test prep in the study order', () => {
  it('prep off: the active L3 lesson’s words come first and the left-over test words are not offered (unchanged)', () => {
    const off = getStudyFocus(profile(), now);
    expect(off.activeLesson).toMatchObject({ bookId: 'b3', n: 1 });
    expect(ids(off)).toEqual(['b3-a', 'b3-b']);
    // switched off explicitly: the same order
    expect(ids(getStudyFocus(profile({ on: false, target: 'L2' }), now))).toEqual(ids(off));
    expect(off.testTarget).toBeUndefined();
  });

  it('prep on (target L2): non-lesson N1–L2 words, lowest level first, come before the lesson above the target', () => {
    const on = getStudyFocus(profile({ on: true, target: 'L2' }), now);
    expect(on.testTarget).toBe('L2');
    expect(ids(on)).toEqual(['N1-9', 'N2-9', 'L1-9', 'L2-9', 'b3-a', 'b3-b']);
    // target L1: L2's words are not test words, so they wait as before
    expect(ids(getStudyFocus(profile({ on: true, target: 'L1' }), now))).toEqual(['N1-9', 'N2-9', 'L1-9', 'b3-a', 'b3-b']);
  });

  it('a lesson up to the target keeps its place ahead of the other test words', () => {
    // the N1 book's lesson is not done yet: it stays the active lesson, the other test words follow it
    const early = getStudyFocus(
      {
        ...profile({ on: true, target: 'L2' }),
        cards: [],
        myClass: { enabled: true, textbookId: 'b1', currentLesson: 1 },
      },
      now,
    );
    expect(early.activeLesson).toMatchObject({ bookId: 'b1', n: 1 });
    expect(ids(early).slice(0, 4)).toEqual(['b1-a', 'b1-b', 'N1-0', 'N1-1']);
    expect(ids(early)).not.toContain('b3-a');
  });

  it('tutoring words stay first and the new-word allowance is never exceeded', () => {
    const f = getStudyFocus(profile({ on: true, target: 'L2' }, { tutorLessons: [{ id: 't1', date: '2026-10-19', wordIds: ['L3-0'] }] as never }), now);
    expect(f.tutorItems?.map((i) => i.id)).toEqual(['L3-0']);
    const tutorCard: SkillCard = { ...card('L3-0', 'recognition', 0), state: 'introduced', card: createEmptyCard(now) };
    const pick = pickNewForSession({ newCards: [tutorCard], focus: f, allowed: 3 });
    expect(pick.cards.map((c) => c.item.id)).toEqual(['L3-0']);
    expect(pick.items.map((i) => i.id)).toEqual(['N1-9', 'N2-9']);
    expect(pick.cards.length + pick.items.length).toBe(3);
  });
});
