// Phase 34: lesson extras are taught with their lesson, in lesson order, without moving lesson mastery.
import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { PRIORITY_CONFIG } from '../curriculum/priority.config.js';
import { lessonCoreItems, lessonExtraWordIds, lessonTaughtItems } from '../progress/terms.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Word } from '../types.js';
import { DEFAULT_STUDY_SETTINGS, getStudyFocus, lessonIndex } from './study-focus.js';

const word = (id: string): Word => ({
  id, headword: id, variants: [], pos: ['N'], level: 'N1', source: 'tocfl', pinyin: '', pinyinNumeric: '', zhuyin: '', glossEn: '', chars: [id], tags: [],
});
const lesson = (n: number, extra: string[] = [], supplementary: string[] = []): Lesson => ({
  id: `laixue-1-L${String(n).padStart(2, '0')}`, n, titleZh: '', titleEn: '', topic: '', objectives: [],
  vocab: [`c${n}a`, `c${n}b`], supplementary, extra, properNouns: [], grammar: [], dialogueRef: '', scenarios: [], journalPrompts: [],
});
const L = [
  lesson(1, ['x1a']),
  lesson(2, ['x2a'], ['s2']),
  lesson(3),
  lesson(4, ['x4a', 'x4b'], ['s4']),
  lesson(5),
  lesson(6, ['x6a']),
];
const book: Textbook = { id: 'laixue-1', titleZh: '', titleEn: '', lessons: L };
const allIds = L.flatMap((l) => [...l.vocab, ...l.supplementary, ...(l.extra ?? [])]);
const lexicon = new Lexicon(allIds.map(word));

const card = (id: string, stability = 30): SkillCard => ({
  item: { kind: 'word', id }, skill: 'recognition', card: { ...createEmptyCard(new Date('2026-01-01')), stability },
  state: 'review', lapses: 0, leech: false, leechTreatmentsTried: [], clozeRung: 1, clozeStreak: 0, familiarity: 0,
  readingDependence: 0, flags: {}, updatedAt: new Date('2026-01-01'),
});
const prod = (id: string): SkillCard => ({ ...card(id, 10), skill: 'production' });
const mastered = (ids: string[]) => ids.flatMap((id) => [card(id), prod(id)]);

const focusOf = (cards: SkillCard[], over: Partial<typeof DEFAULT_STUDY_SETTINGS> = {}, cfg = PRIORITY_CONFIG, currentLesson = 6) =>
  getStudyFocus({
    lexicon, books: [book], cards, grammarUses: new Map(), config: cfg,
    myClass: { enabled: true, textbookId: 'laixue-1', currentLesson },
    settings: { ...DEFAULT_STUDY_SETTINGS, ...over },
  });
const ids = (xs: { id: string }[]) => xs.map((i) => i.id);

describe('lesson extras (Phase 34)', () => {
  it('extras are supplementary + extra words, never a core word or name', () => {
    expect(lessonExtraWordIds(lesson(4, ['x4a', 'c4a'], ['s4']))).toEqual(['s4', 'x4a']);
    expect(ids(lessonCoreItems(L[3]!))).toEqual(['c4a', 'c4b']);
    expect(ids(lessonTaughtItems(L[3]!, true))).toEqual(['c4a', 'c4b', 's4', 'x4a', 'x4b']);
    expect(ids(lessonTaughtItems(L[3]!, false))).toEqual(['c4a', 'c4b']);
  });

  it('lesson mastery is unchanged by default: all core mastered, no extra mastered = done', () => {
    const core = L.flatMap((l) => l.vocab);
    const f = focusOf(mastered(core), {}, PRIORITY_CONFIG, 3);
    expect(f.masteredLessonIds).toEqual(L.map((l) => l.id));
  });

  it('with the flag on the same learner has not mastered lessons that have extras', () => {
    const core = L.flatMap((l) => l.vocab);
    const on = { ...PRIORITY_CONFIG, extrasCountForLessonMastery: true };
    const f = focusOf(mastered(core), {}, on, 3);
    expect(f.masteredLessonIds).toEqual([L[2]!.id, L[4]!.id]); // lessons 3 and 5 have none
  });

  it('with the flag on but extras not taught, extras cannot block a lesson', () => {
    const core = L.flatMap((l) => l.vocab);
    const on = { ...PRIORITY_CONFIG, extrasCountForLessonMastery: true };
    expect(focusOf(mastered(core), { teachExtras: false }, on, 3).masteredLessonIds).toHaveLength(6);
  });

  it('new words: the active lesson\'s core words, then extras of earlier lessons (earliest first), then its own', () => {
    // lessons 1-5 core mastered; lesson 6 core not started; no card for any extra yet
    const f = focusOf(mastered(L.slice(0, 5).flatMap((l) => l.vocab)));
    expect(f.activeLesson?.lessonId).toBe(L[5]!.id);
    expect(ids(f.newItemsAllowed)).toEqual(['c6a', 'c6b', 'x1a', 's2', 'x2a', 's4', 'x4a', 'x4b', 'x6a']);
    // lesson 4's extras arrive before lesson 6's own
    expect(ids(f.newItemsAllowed).indexOf('x4a')).toBeLessThan(ids(f.newItemsAllowed).indexOf('x6a'));
  });

  it('an extra the learner already has a card for is not introduced again', () => {
    const f = focusOf([...mastered(L.slice(0, 5).flatMap((l) => l.vocab)), card('x1a', 3)]);
    expect(ids(f.newItemsAllowed)).not.toContain('x1a');
  });

  it('"Teach extra words with lessons" off: no extra is ever introduced', () => {
    const f = focusOf(mastered(L.slice(0, 5).flatMap((l) => l.vocab)), { teachExtras: false });
    expect(ids(f.newItemsAllowed)).toEqual(['c6a', 'c6b']);
  });

  it('extras rank with their lesson in the study order (first lesson that teaches a word wins)', () => {
    const idx = lessonIndex([book]);
    expect(idx.get('word:x4a')).toBe(L[3]!.id);
    expect(idx.get('word:s2')).toBe(L[1]!.id);
    expect(lessonIndex([book], undefined, false).has('word:x4a')).toBe(false);
  });
});
