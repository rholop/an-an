import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classScope,
  lessonTag,
  nextNewItems,
  textbookTag,
  Lexicon,
  type Lesson,
  type Textbook,
  type Word,
} from '@anan/core';
import { DexieLearnerRepo } from '../db/learner-repo.js';
import { AnanDB } from '../db/schema.js';
import { LearnerService } from './learner-service.js';
import { recordLessonCoverage } from './my-class.js';

let db: AnanDB;
let service: LearnerService;
beforeEach(() => {
  db = new AnanDB(`anan-test-${Math.random()}`);
  service = new LearnerService(new DexieLearnerRepo(db));
});
afterEach(async () => {
  await db.delete();
});

const NOW = new Date('2026-10-04T00:00:00Z');
const word = (n: number): Word => ({
  id: `w${n}`,
  headword: `字${n}`,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [`字${n}`],
  tags: [textbookTag(), lessonTag(n)],
  freqRank: n,
});
const lesson = (n: number): Lesson => ({
  id: `laixue-1-L${String(n).padStart(2, '0')}`,
  n,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: [`w${n}`],
  supplementary: [],
  properNouns: [],
  grammar: [`gram-${n}`],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
});
const book: Textbook = {
  id: 'laixue-1',
  titleZh: '',
  titleEn: '',
  lessons: Array.from({ length: 10 }, (_, i) => lesson(i + 1)),
};
const setting = (currentLesson: number, coveredThrough?: number) => ({
  enabled: true,
  textbookId: 'laixue-1',
  currentLesson,
  ...(coveredThrough !== undefined ? { coveredThrough } : {}),
});

describe('recordLessonCoverage (My class → learner model)', () => {
  it('current lesson 4: lessons 1–4 words and grammar become introduced, nothing from 5+', async () => {
    const r = await recordLessonCoverage(book, setting(4), service, NOW);
    expect(r.cards).toBe(8);
    for (const n of [1, 2, 3, 4]) {
      expect((await service.getCard({ kind: 'word', id: `w${n}` }, 'recognition'))?.state).toBe(
        'introduced',
      );
      expect(
        (await service.getCard({ kind: 'grammar', id: `gram-${n}` }, 'recognition'))?.state,
      ).toBe('introduced');
    }
    expect(await service.getCard({ kind: 'word', id: 'w5' }, 'recognition')).toBeUndefined();
    // Never "known": nothing is in review yet.
    expect((await service.wordSets(NOW)).knownIds.size).toBe(0);
  });

  it('lesson 4 gets top priority in new items; lessons 6–10 stay out', async () => {
    await recordLessonCoverage(book, setting(3), service, NOW);
    const lexicon = new Lexicon(Array.from({ length: 10 }, (_, i) => word(i + 1)));
    const cards = await db.items.toArray();
    const picked = nextNewItems(cards, lexicon, 10, {
      currentLevel: 'N1',
      classScope: classScope(setting(4)),
    }).map((w) => w.id);
    expect(picked[0]).toBe('w4');
    expect(picked).toContain('w5');
    expect(picked.some((id) => ['w6', 'w7', 'w8', 'w9', 'w10'].includes(id))).toBe(false);
  });

  it('going back a lesson deletes nothing and moving forward again does not re-log', async () => {
    await recordLessonCoverage(book, setting(4), service, NOW);
    const before = await db.items.count();
    const back = await recordLessonCoverage(book, setting(2, 4), service, NOW);
    expect(back.events).toBe(0);
    expect(await db.items.count()).toBe(before);
    const fwd = await recordLessonCoverage(book, setting(5, 4), service, NOW);
    expect(fwd.cards).toBe(2); // only lesson 5's word + grammar
  });

  it('does nothing when My class is off', async () => {
    const r = await recordLessonCoverage(book, { ...setting(4), enabled: false }, service, NOW);
    expect(r.events).toBe(0);
    expect(await db.items.count()).toBe(0);
  });
});

// ---- Phase 13: book + lesson across the series
const bookOf = (id: string, prefix: string): Textbook => ({
  id,
  titleZh: '',
  titleEn: '',
  lessons: Array.from({ length: 10 }, (_, i) => ({
    ...lesson(i + 1),
    id: `${id}-L${String(i + 1).padStart(2, '0')}`,
    vocab: [`${prefix}${i + 1}`],
    grammar: [`g-${prefix}${i + 1}`],
  })),
});
const b2 = bookOf('laixue-2', 'b');

describe('My class across books', () => {
  const at = (textbookId: string, currentLesson: number, coveredThrough?: number) => ({
    enabled: true,
    textbookId,
    currentLesson,
    ...(coveredThrough !== undefined ? { coveredThrough } : {}),
  });

  it('book 2 lesson 3 covers all of book 1 and lessons 1–3 of book 2, nothing of lesson 5+', async () => {
    const r = await recordLessonCoverage([book, b2], at('laixue-2', 3), service, NOW);
    expect(r.coveredThrough).toBe(13);
    expect(r.cards).toBe(2 * 10 + 2 * 3);
    expect(await service.getCard({ kind: 'word', id: 'w10' }, 'recognition')).toBeDefined();
    expect(await service.getCard({ kind: 'word', id: 'b3' }, 'recognition')).toBeDefined();
    expect(await service.getCard({ kind: 'word', id: 'b5' }, 'recognition')).toBeUndefined();
    expect(await service.getCard({ kind: 'grammar', id: 'g-b4' }, 'recognition')).toBeUndefined();
  });

  it('advancing within book 2 only logs the new lesson; a Phase 12 value (laixue-1, 4) is unchanged', async () => {
    await recordLessonCoverage([book, b2], at('laixue-2', 3), service, NOW);
    const next = await recordLessonCoverage([book, b2], at('laixue-2', 4, 13), service, NOW);
    expect(next.cards).toBe(2);
  });

  it('legacy stored value: coveredThrough was a book-1 lesson number = its course position', async () => {
    const legacy = await recordLessonCoverage(book, at('laixue-1', 6, 4), service, NOW);
    expect(legacy.cards).toBe(4); // lessons 5–6 only: 2 words + 2 grammar items
    expect(legacy.coveredThrough).toBe(6);
  });

  it('Phase 21: lessons held back by the TOCFL gate are listed but not introduced; coverage resumes later', async () => {
    const gated = new Set(['laixue-2-L01', 'laixue-2-L02', 'laixue-2-L03']);
    const r = await recordLessonCoverage([book, b2], at('laixue-2', 3), service, NOW, gated);
    expect(r.coveredThrough).toBe(10);
    expect(await service.getCard({ kind: 'word', id: 'w10' }, 'recognition')).toBeDefined();
    expect(await service.getCard({ kind: 'word', id: 'b1' }, 'recognition')).toBeUndefined();
    // the gate opens: the rest is covered from where it stopped
    const later = await recordLessonCoverage([book, b2], at('laixue-2', 3, 10), service, NOW);
    expect(later.coveredThrough).toBe(13);
    expect(await service.getCard({ kind: 'word', id: 'b3' }, 'recognition')).toBeDefined();
  });

  it('a Phase 12 profile (book 1, lesson n) produces the same queue as before', () => {
    const lex = new Lexicon(Array.from({ length: 10 }, (_, i) => word(i + 1)));
    const picked = (s: ReturnType<typeof classScope>) =>
      nextNewItems([], lex, 10, { currentLevel: 'N1', classScope: s }).map((w) => w.id);
    expect(picked(classScope(at('laixue-1', 4)))).toEqual(picked(classScope({ enabled: true, textbookId: 'laixue-1', currentLesson: 4 })));
    // Phase 21: the class scope is visibility only; priority comes from the study focus (priorityIds).
    const first = nextNewItems([], lex, 10, { currentLevel: 'N1', classScope: classScope(at('laixue-1', 4)), priorityIds: ['w4'] });
    expect(first[0]?.id).toBe('w4');
  });
});
