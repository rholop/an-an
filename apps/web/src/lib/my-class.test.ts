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
    expect((await service.knownSet('review')).size).toBe(0);
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
