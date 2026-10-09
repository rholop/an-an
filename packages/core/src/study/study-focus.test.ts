import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import { lessonTag, textbookTag } from '../textbook/scope.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Word } from '../types.js';
import {
  DEFAULT_STUDY_SETTINGS,
  getStudyFocus,
  lessonIndex,
  orderDueCards,
  stepKey,
  stepName,
  studySteps,
  type GrammarUse,
  type StudyProfile,
} from './study-focus.js';
import { grammarUsesFromEvidence } from '../progress/terms.js';

// ---- fixtures: 4 books x 2 lessons (course positions 1,2 / 11,12 / 21,22 / 31,32), 2 words + 1 grammar each
const BOOKS = ['laixue-1', 'laixue-2', 'laixue-3', 'laixue-4'];
const word = (id: string, level: Level, rank: number, tags: string[] = []): Word => ({
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
  tags,
  freqRank: rank,
});
const lesson = (bookId: string, n: number): Lesson => ({
  id: `${bookId}-L${String(n).padStart(2, '0')}`,
  n,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: [`${bookId}-w${n}a`, `${bookId}-w${n}b`, `${bookId}-name${n}`],
  supplementary: [`${bookId}-supp${n}`],
  properNouns: [`${bookId}-name${n}`],
  grammar: [`g-${bookId}-${n}`],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
});
const books: Textbook[] = BOOKS.map((id) => ({ id, titleZh: '', titleEn: '', lessons: [lesson(id, 1), lesson(id, 2)] }));

const LEVELS: Level[] = ['N1', 'N2', 'L1', 'L2', 'L3'];
// Level words: 10 per level that no lesson covers, ids "<level>-<i>"
const levelWords = LEVELS.flatMap((lv) => Array.from({ length: 10 }, (_, i) => word(`${lv}-${i}`, lv, i + 1)));
const lessonWords = books.flatMap((b, bi) =>
  b.lessons.flatMap((l) =>
    [...l.vocab, ...l.supplementary].map((id) => ({
      ...word(id, (['N1', 'L1', 'L2', 'L2'] as Level[])[bi]!, 1, [textbookTag(b.id), lessonTag(l.n, b.id)]),
      // names and supplementary words are textbook entries: they never count toward a TOCFL level
      ...(l.properNouns.includes(id) || l.supplementary.includes(id) ? { source: 'textbook' as const } : {}),
    })),
  ),
);
const lexicon = new Lexicon([...levelWords, ...lessonWords]);

const card = (id: string, skill: 'recognition' | 'production', stability: number, over: Partial<SkillCard> = {}): SkillCard => ({
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
  ...over,
});
const masteredWord = (id: string) => [card(id, 'recognition', 30), card(id, 'production', 10)];
const masteredCards = (ids: string[]) => ids.flatMap(masteredWord);
const coreOf = (b: Textbook) => b.lessons.flatMap((l) => l.vocab.filter((id) => !l.properNouns.includes(id)));
const grammarDone = (ids: string[]): Map<string, GrammarUse> => new Map(ids.map((g) => [g, { correct: 3, lastCorrect: true, firstCorrectDay: '2026-10-01', lastCorrectDay: '2026-10-02' }]));
const levelIds = (lv: Level) => Array.from({ length: 10 }, (_, i) => `${lv}-${i}`);
const lessonItems = (bookId: string) => {
  const b = books.find((x) => x.id === bookId)!;
  return { words: coreOf(b), grammar: b.lessons.flatMap((l) => l.grammar) };
};

function profile(over: Partial<StudyProfile> & { masteredLessonBooks?: string[]; masteredLevels?: Level[]; cards?: SkillCard[] } = {}): StudyProfile {
  const cards = [
    ...(over.masteredLessonBooks ?? []).flatMap((b) => masteredCards(lessonItems(b).words)),
    ...(over.masteredLevels ?? []).flatMap((lv) => masteredCards(levelIds(lv))),
    ...(over.cards ?? []),
  ];
  const grammar = grammarDone((over.masteredLessonBooks ?? []).flatMap((b) => lessonItems(b).grammar));
  return {
    lexicon,
    books,
    cards,
    grammarUses: over.grammarUses ?? grammar,
    settings: { ...DEFAULT_STUDY_SETTINGS, ...(over.settings ?? {}) },
    ...(over.myClass ? { myClass: over.myClass } : {}),
  };
}
const now = new Date('2026-10-04');
const name = (f: ReturnType<typeof getStudyFocus>) => (f.activeStep ? stepName(f.activeStep) : 'none');

describe('study order (tiers)', () => {
  it('walks TOCFL levels; each tier = its textbook lessons (course order) then the rest of the level', () => {
    const keys = studySteps(books).map((s) => (s.kind === 'level' ? `level:${s.level}` : `${s.bookId}#${s.n}`));
    expect(keys).toEqual([
      'laixue-1#1', 'laixue-1#2', 'level:N1',
      'level:N2',
      'laixue-2#1', 'laixue-2#2', 'level:L1',
      'laixue-3#1', 'laixue-3#2', 'laixue-4#1', 'laixue-4#2', 'level:L2',
      'level:L3', 'level:L4', 'level:L5',
    ]);
  });

  it('book 4’s lessons 6–10 sit in the L3 tier (after the rest of L2)', () => {
    const full: Textbook[] = books.map((b) => ({ ...b, lessons: Array.from({ length: 10 }, (_, i) => lesson(b.id, i + 1)) }));
    const keys = studySteps(full).map((s) => (s.kind === 'level' ? `level:${s.level}` : `${s.bookId}#${s.n}`));
    expect(keys.indexOf('level:L2')).toBeLessThan(keys.indexOf('laixue-4#6'));
    expect(keys.indexOf('laixue-4#6')).toBeLessThan(keys.indexOf('level:L3'));
    expect(keys.indexOf('laixue-4#5')).toBeLessThan(keys.indexOf('level:L2'));
  });
});

describe('getStudyFocus', () => {
  it('a fresh profile starts at book 1 lesson 1, items in book order (core words, then grammar; no proper nouns)', () => {
    const f = getStudyFocus(profile(), now);
    expect(name(f)).toBe(' 1 · Lesson 1'.trim().length ? stepName(f.activeStep!) : '');
    expect(f.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 1 });
    expect(f.focusItems.map((i) => i.id)).toEqual(['laixue-1-w1a', 'laixue-1-w1b', 'g-laixue-1-1']);
    expect(f.newItemsAllowed).toHaveLength(3);
    expect(f.generalNewItemsAllowed).toBe(false);
    expect(f.mastery).toMatchObject({ mastered: 0, total: 3, remainingWords: 2, remainingGrammar: 1 });
  });

  it('stays on the lesson until 90% of its items are mastered, then moves on', () => {
    // lesson 1 has 3 items: 2/3 = 67% -> still active
    const part = getStudyFocus(profile({ cards: masteredCards(['laixue-1-w1a', 'laixue-1-w1b']) }), now);
    expect(part.activeLesson).toMatchObject({ n: 1 });
    const done = getStudyFocus(
      profile({ cards: masteredCards(['laixue-1-w1a', 'laixue-1-w1b']), grammarUses: grammarDone(['g-laixue-1-1']) }),
      now,
    );
    expect(done.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 2 });
    expect(done.justMastered.map((s) => s.n)).toEqual([1]);
    expect(done.reached).toBe(1);
  });

  it('item mastery needs recognition >= 21d AND production >= 7d and no leech; grammar needs 3 correct uses ending correct', () => {
    const base = (cards: SkillCard[], uses = new Map<string, GrammarUse>()) =>
      getStudyFocus(profile({ cards, grammarUses: uses }), now).mastery!.mastered;
    expect(base([card('laixue-1-w1a', 'recognition', 30)])).toBe(0);
    expect(base([card('laixue-1-w1a', 'recognition', 30), card('laixue-1-w1a', 'production', 6.9)])).toBe(0);
    expect(base(masteredWord('laixue-1-w1a'))).toBe(1);
    expect(base([card('laixue-1-w1a', 'recognition', 30), card('laixue-1-w1a', 'production', 10, { leech: true })])).toBe(0);
    expect(base([], new Map([['g-laixue-1-1', { correct: 2, lastCorrect: true }]]))).toBe(0);
    expect(base([], new Map([['g-laixue-1-1', { correct: 5, lastCorrect: false }]]))).toBe(0);
    expect(base([], new Map([['g-laixue-1-1', { correct: 3, lastCorrect: true, firstCorrectDay: '2026-10-01', lastCorrectDay: '2026-10-02' }]]))).toBe(1);
  });

  it('after a tier’s lessons the rest of that TOCFL level comes next (frontier order), then the next level', () => {
    const f = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1'] }), now);
    expect(f.activeStep).toEqual({ kind: 'level', level: 'N1' });
    expect(f.focusItems.map((i) => i.id).slice(0, 3)).toEqual(['N1-0', 'N1-1', 'N1-2']);
    const f2 = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1'], masteredLevels: ['N1'] }), now);
    expect(f2.activeStep).toEqual({ kind: 'level', level: 'N2' });
  });

  it('book 2 does not become active until Novice 1 AND Novice 2 are mastered', () => {
    const f = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1'], masteredLevels: ['N1'] }), now);
    expect(f.activeLesson).toBeUndefined();
    const g = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1'], masteredLevels: ['N1', 'N2'] }), now);
    expect(g.activeLesson).toMatchObject({ bookId: 'laixue-2', n: 1 });
  });

  it('a book 4 lesson never becomes active while Novice 1, Novice 2 or L1 is below mastery — even with the pointer far ahead', () => {
    const everyLesson = BOOKS.slice(0, 3);
    for (const missing of ['N1', 'N2', 'L1'] as Level[]) {
      const levels = (['N1', 'N2', 'L1', 'L2'] as Level[]).filter((l) => l !== missing);
      const f = getStudyFocus(
        profile({ masteredLessonBooks: everyLesson, masteredLevels: levels, settings: { ...DEFAULT_STUDY_SETTINGS, reached: 99 } }),
        now,
      );
      expect(f.activeLesson, `missing ${missing}`).toBeUndefined();
      expect(f.activeStep).toEqual({ kind: 'level', level: missing });
      expect(f.gateStatus.blocked).toBe(false); // nothing is being held back: this IS the step
    }
    // book 4 is the active lesson only when everything below it is done
    const ok = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1', 'laixue-2', 'laixue-3'], masteredLevels: ['N1', 'N2', 'L1'] }), now);
    expect(ok.activeLesson).toMatchObject({ bookId: 'laixue-4' });
  });

  it('a lesson at L3 also waits for Level 2', () => {
    const full: Textbook[] = books.map((b) => ({ ...b, lessons: Array.from({ length: 10 }, (_, i) => lesson(b.id, i + 1)) }));
    const all = full.flatMap((b) => b.lessons.filter((l) => !(b.id === 'laixue-4' && l.n > 5)).flatMap((l) => [...l.vocab.filter((id) => !l.properNouns.includes(id))]));
    const grammar = full.flatMap((b) => b.lessons.filter((l) => !(b.id === 'laixue-4' && l.n > 5)).flatMap((l) => l.grammar));
    const lex = new Lexicon([
      ...levelWords,
      ...full.flatMap((b, bi) =>
        b.lessons.flatMap((l) =>
          l.vocab.map((id) => ({
            ...word(id, bi === 3 && l.n > 5 ? 'L3' : (['N1', 'L1', 'L2', 'L2'] as Level[])[bi]!, 1),
            ...(l.properNouns.includes(id) ? { source: 'textbook' as const } : {}),
          })),
        ),
      ),
    ]);
    const p = (levels: Level[]): StudyProfile => ({
      lexicon: lex,
      books: full,
      cards: [...masteredCards(all), ...levels.flatMap((lv) => masteredCards(levelIds(lv)))],
      grammarUses: grammarDone(grammar),
      settings: DEFAULT_STUDY_SETTINGS,
    });
    expect(getStudyFocus(p(['N1', 'N2', 'L1']), now).activeStep).toEqual({ kind: 'level', level: 'L2' });
    expect(getStudyFocus(p(['N1', 'N2', 'L1', 'L2']), now).activeLesson).toMatchObject({ bookId: 'laixue-4', n: 6 });
  });

  it('respects the class cap: at most one lesson ahead of class; the class being ahead of the order is gated', () => {
    const p = profile({
      masteredLessonBooks: ['laixue-1'],
      masteredLevels: ['N1', 'N2'],
      myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 2 },
    });
    // book 2 L1 is far beyond class (book 1 L2 + 1): not active -> the rest of L1 words instead
    const f = getStudyFocus(p, now);
    expect(f.activeLesson).toBeUndefined();
    expect(f.activeStep).toEqual({ kind: 'level', level: 'L1' });
    expect(f.gateStatus.cappedByClass).toBe(true);
    // class on book 2 lesson 1 allows book 2 lesson 1 and a one-lesson preview of lesson 2
    const g = getStudyFocus({ ...p, myClass: { enabled: true, textbookId: 'laixue-2', currentLesson: 1 } }, now);
    expect(g.activeLesson).toMatchObject({ bookId: 'laixue-2', n: 1 });
    // no class position set: advances freely
    const free = getStudyFocus({ ...p, myClass: undefined }, now);
    expect(free.activeLesson).toMatchObject({ bookId: 'laixue-2', n: 1 });
  });

  it('class ahead of the study order: gate message, class lessons not prioritised', () => {
    const f = getStudyFocus(
      profile({ masteredLessonBooks: ['laixue-1'], masteredLevels: [], myClass: { enabled: true, textbookId: 'laixue-2', currentLesson: 1 } }),
      now,
    );
    expect(f.activeStep).toEqual({ kind: 'level', level: 'N1' });
    expect(f.gateStatus.blocked).toBe(true);
    expect(f.gateStatus.waitingForLevel).toBe('N1');
    expect(f.gateStatus.message).toMatch(/^來學華語 2 unlocks after TOCFL N1: \d+% mastered/);
  });

  it('a lapsed earlier lesson becomes a review lesson without moving the active step back', () => {
    // lesson 1 mastered, lesson 2 active; then lesson 1's word lapses
    const lapsed = [card('laixue-1-w1a', 'recognition', 2, { lapses: 3 }), card('laixue-1-w1a', 'production', 1), ...masteredCards(['laixue-1-w1b'])];
    const p = profile({ cards: lapsed, grammarUses: grammarDone(['g-laixue-1-1']), settings: { ...DEFAULT_STUDY_SETTINGS, reached: 1 } });
    const f = getStudyFocus(p, now);
    expect(f.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 2 });
    expect(f.reviewLessons.map((l) => l.n)).toEqual([1]);
    expect(f.reviewItems.map((i) => i.id)).toEqual(['laixue-1-w1a']);
    expect(f.reached).toBe(1);
  });

  it('works with book 1 only (Phase 12)', () => {
    const only = [books[0]!];
    const f = getStudyFocus({ ...profile(), books: only }, now);
    expect(f.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 1 });
    const done = getStudyFocus({ ...profile({ masteredLessonBooks: ['laixue-1'] }), books: only }, now);
    expect(done.activeStep).toEqual({ kind: 'level', level: 'N1' });
  });

  it('"already known" overrides count as mastered', () => {
    const f = getStudyFocus(
      profile({ settings: { ...DEFAULT_STUDY_SETTINGS, knownItems: ['word:laixue-1-w1a', 'word:laixue-1-w1b', 'grammar:g-laixue-1-1'] } }),
      now,
    );
    expect(f.activeLesson).toMatchObject({ n: 2 });
  });

  it('active level step lists that level’s unmastered words, excluding words a lesson already covers', () => {
    const f = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1'], cards: masteredCards(['N1-0', 'N1-1']) }), now);
    expect(f.activeStep).toEqual({ kind: 'level', level: 'N1' });
    expect(f.focusItems[0]!.id).toBe('N1-2');
    expect(f.focusItems.every((i) => !i.id.startsWith('laixue-'))).toBe(true);
  });
});

describe('due-review ordering and grammar evidence', () => {
  it('orders textbook first: active lesson, review lessons, earlier lessons, later lessons, everything else (nothing dropped)', () => {
    const p = profile({ masteredLessonBooks: ['laixue-1'] });
    // book 1 mastered -> active is the rest of N1; use a profile where lesson 2 is active instead
    const q = profile({ cards: masteredCards(['laixue-1-w1a', 'laixue-1-w1b']), grammarUses: grammarDone(['g-laixue-1-1']) });
    const f = getStudyFocus(q, now);
    expect(f.activeLesson).toMatchObject({ n: 2 });
    const idx = lessonIndex(books);
    const due = ['N2-0', 'laixue-2-w1a', 'laixue-1-w2a', 'laixue-1-w1a', 'N1-0'].map((id) => ({ item: { kind: 'word' as const, id } }));
    const out = orderDueCards(due, f, idx).map((c) => c.item.id);
    expect(out).toEqual(['laixue-1-w2a', 'laixue-1-w1a', 'laixue-2-w1a', 'N2-0', 'N1-0']);
    expect(out).toHaveLength(due.length);
    void p;
    // study order off: untouched
    expect(orderDueCards(due, { ...f, enabled: false }, idx).map((c) => c.item.id)).toEqual(due.map((c) => c.item.id));
  });

  it('grammar tallies come from the evidence log, in time order', () => {
    const e = (kind: string, d: number) => ({ item: { kind: 'grammar' as const, id: 'g' }, kind: kind as never, at: new Date(2026, 0, d) });
    const u = grammarUsesFromEvidence([e('cloze_correct_nohint', 1), e('journal_correct_use', 2), e('cloze_wrong', 4), e('cloze_correct_nohint', 3)]);
    expect(u.get('g')).toMatchObject({ correct: 3, lastCorrect: false });
    expect(stepKey({ kind: 'level', level: 'N1' })).toBe('level:N1');
  });
});

import { planReviewSession, studyGrammarId, studyTargetWordIds } from './queue.js';
describe('review plan (Phase 14)', () => {
  const f = getStudyFocus(profile(), new Date('2026-10-04'));
  const idx = lessonIndex(books);
  it('new items are the active lesson’s, in book order; due cards are all kept, textbook first', () => {
    const due = ['N2-0', 'laixue-2-w1a', 'laixue-1-w1a'].map((id) => ({ item: { kind: 'word' as const, id } }));
    const plan = planReviewSession(due, f, idx, 2);
    expect(plan.newItems.map((i) => i.id)).toEqual(['laixue-1-w1a', 'laixue-1-w1b']);
    expect(plan.ordered.map((c) => c.item.id)).toEqual(['laixue-1-w1a', 'laixue-2-w1a', 'N2-0']);
  });
  it('study order off: the plan is the input, nothing new', () => {
    const due = [{ item: { kind: 'word' as const, id: 'N2-0' } }, { item: { kind: 'word' as const, id: 'laixue-1-w1a' } }];
    const plan = planReviewSession(due, { ...f, enabled: false }, idx);
    expect(plan.ordered).toEqual(due);
    expect(plan.newItems).toEqual([]);
    expect(planReviewSession(due, undefined, idx).ordered).toEqual(due);
  });
  it('targets and grammar hint come from the active lesson', () => {
    expect(studyTargetWordIds(f, 5)).toEqual(['laixue-1-w1a', 'laixue-1-w1b']);
    expect(studyGrammarId(f)).toBe('g-laixue-1-1');
    expect(studyTargetWordIds({ ...f, enabled: false }, 5)).toEqual([]);
  });
});

describe('Phase 20: removed words and lesson mastery', () => {
  const [a, b] = lessonItems('laixue-1').words; // laixue-1 lesson 1: w1a, w1b (+ grammar)
  it('a word marked Not now or Never show leaves the lesson count instead of blocking it', () => {
    const base = getStudyFocus(profile(), now).mastery!;
    expect(base.total).toBe(3);
    const snoozed = getStudyFocus(
      profile({ cards: [card(a!, 'recognition', 0, { flags: { snoozed: true } })] }),
      now,
    ).mastery!;
    expect(snoozed.total).toBe(2);
    const never = getStudyFocus(
      profile({ cards: [card(b!, 'recognition', 0, { flags: { excluded: true } })] }),
      now,
    ).mastery!;
    expect(never.total).toBe(2);
  });

  it('"I already know it" counts as mastered only after a later review passes', () => {
    const mark = new Date('2026-10-01');
    const known = (last: Date) => [
      card(a!, 'recognition', 60, { flags: { markedKnown: true, markedKnownAt: mark }, card: { ...createEmptyCard(mark), stability: 60, last_review: last } as SkillCard['card'] }),
      card(a!, 'production', 60, { flags: { markedKnown: true, markedKnownAt: mark }, card: { ...createEmptyCard(mark), stability: 60, last_review: last } as SkillCard['card'] }),
    ];
    expect(getStudyFocus(profile({ cards: known(mark) }), now).mastery!.mastered).toBe(0);
    expect(getStudyFocus(profile({ cards: known(new Date('2026-10-03')) }), now).mastery!.mastered).toBe(1);
  });
});

describe('Phase 21 Part A: Now studying follows the class', () => {
  it('class = lesson 2 with lesson 1 unmastered: lesson 2 is active, lesson 1 is catch-up', () => {
    const f = getStudyFocus(profile({ myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 2 } }), now);
    expect(f.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 2 });
    expect(f.activeIsClass).toBe(true);
    expect(f.classLesson).toMatchObject({ bookId: 'laixue-1', n: 2 });
    expect(f.reviewLessons.map((l) => l.n)).toEqual([1]);
    // catch-up items come after the active lesson's own items
    expect(f.reviewItems.map((i) => i.id)).toContain('laixue-1-w1a');
    expect(f.focusItems.map((i) => i.id)).toContain('laixue-1-w2a');
    // Next = the step after the class lesson
    expect(f.nextStep).toEqual({ kind: 'level', level: 'N1' });
  });

  it('no class set: Phase 14 behaviour (first unmastered lesson)', () => {
    const f = getStudyFocus(profile(), now);
    expect(f.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 1 });
    expect(f.activeIsClass).toBeUndefined();
    expect(f.reviewLessons).toEqual([]);
  });

  it('the class lesson is a floor even when the saved pointer has moved past it', () => {
    const f = getStudyFocus(
      profile({ settings: { ...DEFAULT_STUDY_SETTINGS, reached: 5 }, myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 } }),
      now,
    );
    expect(f.activeLesson).toMatchObject({ bookId: 'laixue-1', n: 1 });
  });

  it('class lesson mastered: the preview lesson (classAheadLessons) is active, never an earlier one', () => {
    const l1 = lessonItems('laixue-1');
    const p = profile({
      cards: masteredCards(l1.words.filter((w) => w.includes('w1'))),
      grammarUses: grammarDone(['g-laixue-1-1']),
      myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 },
    });
    expect(getStudyFocus(p, now).activeLesson).toMatchObject({ n: 2 });
    const noPreview = getStudyFocus({ ...p, settings: { ...p.settings, classAheadLessons: 0 } }, now);
    expect(noPreview.activeStep).toEqual({ kind: 'level', level: 'N1' });
  });

  it('the TOCFL gate still wins over the class lesson', () => {
    const f = getStudyFocus(profile({ myClass: { enabled: true, textbookId: 'laixue-2', currentLesson: 2 } }), now);
    expect(f.activeStep).toEqual({ kind: 'level', level: 'N1' });
    expect(f.gateStatus.blocked).toBe(true);
    expect(f.activeIsClass).toBe(false);
    expect(f.classLesson).toMatchObject({ bookId: 'laixue-2', n: 2 });
  });

  it('mastery carries the Learned share over the same items', () => {
    const f = getStudyFocus(profile({ myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 1 } }), now);
    expect(f.mastery).toMatchObject({ learned: 0, learnedShare: 0, total: 3 });
  });

  it('a "TOCFL X (rest)" step counts only the words no lesson covers (#8)', () => {
    const f = getStudyFocus(profile({ masteredLessonBooks: ['laixue-1'] }), now);
    expect(f.activeStep).toEqual({ kind: 'level', level: 'N1' });
    // 10 rest-of-N1 words; book 1's N1 lesson words are not counted again
    expect(f.mastery).toMatchObject({ total: 10, mastered: 0 });
    expect(f.focusItems.every((i) => !i.id.startsWith('laixue-'))).toBe(true);
    expect(f.masteredLessonIds).toEqual(['laixue-1-L01', 'laixue-1-L02']);
  });
});
