import { describe, expect, it } from 'vitest';
import { levelNewCandidates } from '../curriculum.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import {
  classScope,
  filterIdsInScope,
  firstLessonOfTags,
  homeLessonOfTags,
  lessonCoveredEvidence,
  lessonScopedWordIds,
  lessonTag,
  lessonsOfTags,
  tagsInScope,
  textbookTag,
} from './scope.js';
import { lessonDone, lessonProgress } from './progress.js';
import { ProgressIndex } from '../progress/terms.js';
import {
  courseLessonLevel,
  courseOrdinal,
  lessonBadge,
  LAIXUE_COURSE,
  locateOrdinal,
} from './course.js';
import type { Lesson, Textbook } from './types.js';

const NOW = new Date('2026-10-04T00:00:00Z');

function word(
  id: string,
  headword: string,
  tags: string[] = [],
  level: Word['level'] = 'N1',
): Word {
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
    glossEn: '',
    chars: [...headword],
    tags,
    freqRank: Number(id.replace(/\D/g, '')) || 1,
  };
}

const tb = (n: number) => [textbookTag(), lessonTag(n)];

function lesson(n: number, vocab: string[], grammar: string[] = []): Lesson {
  return {
    id: `laixue-1-L${String(n).padStart(2, '0')}`,
    n,
    titleZh: '',
    titleEn: '',
    topic: '',
    objectives: [],
    vocab,
    supplementary: [],
    properNouns: [],
    grammar,
    dialogueRef: '',
    scenarios: [],
    journalPrompts: [],
  };
}

// Lessons 1–10, one word each (w1..w10), plus a grammar item per lesson.
const words: Word[] = [
  ...Array.from({ length: 10 }, (_, i) => word(`w${i + 1}`, `字${i + 1}`, tb(i + 1))),
  word('free1', '自由', [], 'N1'),
  word('free2', '空', [], 'N1'),
];
const book: Textbook = {
  id: 'laixue-1',
  titleZh: '來學華語 第一冊',
  titleEn: "Let's Learn Mandarin 1",
  lessons: Array.from({ length: 10 }, (_, i) => lesson(i + 1, [`w${i + 1}`], [`gram-${i + 1}`])),
};

describe('tags', () => {
  it('builds and reads lesson tags', () => {
    expect(lessonTag(3)).toBe('textbook:laixue-1:L03');
    expect(lessonBadge(3)).toBe('來學華語 1 · Lesson 3');
    expect(lessonBadge(5, 'laixue-2')).toBe('來學華語 2 · Lesson 5');
    expect(lessonsOfTags(['x', ...tb(6), lessonTag(3)])).toEqual([3, 6]);
    expect(firstLessonOfTags(['x'])).toBeUndefined();
  });
});

describe('class scope', () => {
  it('off: everything is in scope (previous behaviour)', () => {
    expect(
      tagsInScope(tb(9), classScope({ enabled: false, textbookId: 'laixue-1', currentLesson: 1 })),
    ).toBe(true);
  });
  it('on at lesson 4: lessons 1–5 in scope, 6–10 out, non-book items untouched', () => {
    const s = classScope({ enabled: true, textbookId: 'laixue-1', currentLesson: 4 });
    expect([1, 4, 5].every((n) => tagsInScope(tb(n), s))).toBe(true);
    expect([6, 7, 10].some((n) => tagsInScope(tb(n), s))).toBe(false);
    expect(tagsInScope([], s)).toBe(true);
    const tags = new Map(words.map((w) => [w.id, w.tags]));
    expect(filterIdsInScope(['w4', 'w6', 'free1', 'unknown'], (id) => tags.get(id), s)).toEqual([
      'w4',
      'free1',
      'unknown',
    ]);
  });
});

describe('lessonCoveredEvidence', () => {
  it('current lesson 4 → lessons 1–4 words and grammar, nothing from 5+', () => {
    const ev = lessonCoveredEvidence(book, 4, NOW);
    const ids = ev.map((e) => `${e.item.kind}:${e.item.id}`);
    expect(ids).toEqual([
      'word:w1',
      'grammar:gram-1',
      'word:w2',
      'grammar:gram-2',
      'word:w3',
      'grammar:gram-3',
      'word:w4',
      'grammar:gram-4',
    ]);
    expect(ev.every((e) => e.kind === 'textbook_lesson_covered')).toBe(true);
  });

  it('introduces a new card and never marks it known or runs FSRS', () => {
    const [e] = lessonCoveredEvidence(book, 1, NOW);
    const r = applyEvidence(undefined, e!, NOW);
    expect(r.card?.state).toBe('introduced');
    expect(r.card?.card.reps).toBe(0);
  });

  it('leaves an existing card exactly as it was', () => {
    const [e] = lessonCoveredEvidence(book, 1, NOW);
    const existing = applyEvidence(undefined, { ...e!, kind: 'review_good' }, NOW).card;
    const r = applyEvidence(existing, e!, NOW);
    expect(r.card).toBeUndefined();
  });
});

/** Phase 29: the level candidates of the one new-word picker (`levelNewCandidates`), My class on. */
const candidates = (lexicon: Lexicon, cards: SkillCard[], scope?: ReturnType<typeof classScope>) =>
  levelNewCandidates({
    lexicon,
    level: 'N1',
    nextLevelToo: false,
    carded: new Set(cards.filter((c) => c.state !== 'unseen').map((c) => c.item.id)),
    knownChars: new Set(),
    ...(scope ? { classScope: scope } : {}),
  }).map((i) => i.id);

describe('new-word candidates with My class', () => {
  const lexicon = new Lexicon(words);
  const idsOf = (cards: SkillCard[], scope: ReturnType<typeof classScope>) => candidates(lexicon, cards, scope);

  it('the next lesson is visible, lessons 6–10 stay out at lesson 4', () => {
    const scope = classScope({ enabled: true, textbookId: 'laixue-1', currentLesson: 4 });
    const cards = lessonCoveredEvidence(book, 3, NOW)
      .filter((e) => e.item.kind === 'word')
      .map((e) => applyEvidence(undefined, e, NOW).card!);
    const picked = idsOf(cards, scope);
    expect(picked).toContain('w4');
    expect(picked).toContain('w5'); // i+1
    for (const out of ['w6', 'w7', 'w8', 'w9', 'w10']) expect(picked).not.toContain(out);
    expect(picked.indexOf('w4')).toBeLessThan(picked.indexOf('w5'));
  });

  it('off: identical to a call without the context', () => {
    const off = classScope({ enabled: false, textbookId: 'laixue-1', currentLesson: 4 });
    const a = candidates(lexicon, []);
    const b = candidates(lexicon, [], off);
    expect(b).toEqual(a);
    expect(b).toContain('w9');
  });

  it('going back a lesson does not remove cards (evidence is additive)', () => {
    const cards = lessonCoveredEvidence(book, 4, NOW).map(
      (e) => applyEvidence(undefined, e, NOW).card!,
    );
    const back = classScope({ enabled: true, textbookId: 'laixue-1', currentLesson: 2 });
    expect(cards.length).toBe(8);
    expect(idsOf(cards, back)).not.toContain('w1');
  });
});

describe('lessonProgress', () => {
  it('counts Learned and Mastered over the core items (Phase 21 shared terms)', () => {
    const mk = (kind: 'word' | 'grammar', id: string, state: SkillCard['state'], over: Partial<SkillCard['card']> = {}, skill: SkillCard['skill'] = 'recognition'): SkillCard => ({
      item: { kind, id },
      skill,
      card: { ...emptyCard(NOW), ...over },
      state,
      lapses: 0,
      leech: false,
      leechTreatmentsTried: [],
      clozeRung: 1,
      clozeStreak: 0,
      familiarity: 0,
      readingDependence: 0,
      flags: {},
      updatedAt: NOW,
    });
    const l = lesson(1, ['a', 'b', 'c'], ['gram-1']);
    const index = new ProgressIndex({
      cards: [
        mk('word', 'a', 'review', { reps: 2, stability: 5 }),
        mk('word', 'b', 'introduced'),
        mk('word', 'c', 'mature', { reps: 6, stability: 30 }),
        mk('word', 'c', 'review', { reps: 3, stability: 9 }, 'production'),
        mk('grammar', 'gram-1', 'learning', { reps: 1 }),
      ],
      grammarUses: new Map([['gram-1', { correct: 1, lastCorrect: true }]]),
    });
    const p = lessonProgress(l, { index });
    expect(p.total).toBe(4);
    expect(p.learned).toBe(3); // a, c, gram-1 (one correct use)
    expect(p.mastered).toBe(1); // c
    expect(p.grammarMastered).toBe(0);
    expect(p.grammarPractised).toBe(1);
    expect(lessonDone(p, 0.9)).toBe(false);
  });
});

import { buildGrammarCloze } from './grammar-exercise.js';

describe('buildGrammarCloze', () => {
  const pool = ['都', '也', '在', '不', '的', '還'];
  it('blanks the pattern word and offers it among other pattern words', () => {
    const ex = buildGrammarCloze(
      { id: 's1', zh: '他們都是學生。', en: 'They are all students.' },
      { id: 'gram-dou-all', focus: ['都'] },
      pool,
      () => 0.4,
    )!;
    expect(ex.before).toBe('他們');
    expect(ex.after).toBe('是學生。');
    expect(ex.answer).toBe('都');
    expect(ex.options).toContain('都');
    expect(ex.options).toHaveLength(4);
    expect(new Set(ex.options).size).toBe(4);
  });

  it('never offers a word that is already in the sentence as a distractor', () => {
    const ex = buildGrammarCloze(
      { zh: '我也在銀行工作。' },
      { id: 'gram-ye-also', focus: ['也'] },
      pool,
      () => 0.1,
    )!;
    expect(ex.options).not.toContain('在');
  });

  it('prefers the longest focus word (沒有 over 有) and skips patterns without one', () => {
    const ex = buildGrammarCloze(
      { zh: '我沒有弟弟。' },
      { id: 'gram-you-meiyou', focus: ['有', '沒有'] },
      ['有', '沒有', '也', '都', '在'],
      () => 0.2,
    )!;
    expect(ex.answer).toBe('沒有');
    expect(
      buildGrammarCloze({ zh: '你忙不忙？' }, { id: 'gram-a-not-a', focus: [] }, pool),
    ).toBeUndefined();
  });
});


// ---- Phase 13: the whole series is one course ------------------------------
const tbBook = (bookId: string, n: number) => [textbookTag(bookId), lessonTag(n, bookId)];

function bookOf(bookId: string, count: number, wordFor: (n: number) => string): Textbook {
  return {
    id: bookId,
    titleZh: '',
    titleEn: '',
    lessons: Array.from({ length: count }, (_, i) => ({
      ...lesson(i + 1, [wordFor(i + 1)], [`g-${bookId}-${i + 1}`]),
      id: `${bookId}-L${String(i + 1).padStart(2, '0')}`,
    })),
  };
}

describe('the course', () => {
  it('numbers lessons across books and round-trips', () => {
    expect(courseOrdinal(LAIXUE_COURSE, 'laixue-1', 1)).toBe(1);
    expect(courseOrdinal(LAIXUE_COURSE, 'laixue-2', 1)).toBe(11);
    expect(courseOrdinal(LAIXUE_COURSE, 'laixue-4', 10)).toBe(40);
    expect(courseOrdinal(LAIXUE_COURSE, 'laixue-2', 11)).toBeUndefined();
    expect(courseOrdinal(LAIXUE_COURSE, 'nope', 1)).toBeUndefined();
    expect(locateOrdinal(LAIXUE_COURSE, 23)).toEqual({ bookId: 'laixue-3', n: 3 });
    for (let o = 1; o <= 40; o++) {
      const at = locateOrdinal(LAIXUE_COURSE, o)!;
      expect(courseOrdinal(LAIXUE_COURSE, at.bookId, at.n)).toBe(o);
    }
  });

  it('maps books to app levels; book 4 splits in half', () => {
    expect(courseLessonLevel(LAIXUE_COURSE, 'laixue-1', 9)).toBe('N1');
    expect(courseLessonLevel(LAIXUE_COURSE, 'laixue-2', 1)).toBe('L1');
    expect(courseLessonLevel(LAIXUE_COURSE, 'laixue-3', 10)).toBe('L2');
    expect(courseLessonLevel(LAIXUE_COURSE, 'laixue-4', 5)).toBe('L2');
    expect(courseLessonLevel(LAIXUE_COURSE, 'laixue-4', 6)).toBe('L3');
  });

  it('a word taught in book 1 and book 3 is one item with both tags; home = book 1', () => {
    const shared = word('w-shared', '朋友', [...tbBook('laixue-1', 6), ...tbBook('laixue-3', 2)]);
    const home = homeLessonOfTags(shared.tags)!;
    expect(home).toMatchObject({ bookId: 'laixue-1', n: 6, ordinal: 6 });
    expect(shared.tags.filter((t) => /^textbook:laixue-\d:L\d\d$/.test(t))).toHaveLength(2);
    // Out-of-order tags still resolve to the earliest lesson of the course.
    const rev = homeLessonOfTags([...tbBook('laixue-3', 2), ...tbBook('laixue-2', 9)])!;
    expect(rev).toMatchObject({ bookId: 'laixue-2', n: 9, ordinal: 19 });
  });
});

describe('class scope across books', () => {
  const b1 = bookOf('laixue-1', 10, (n) => `a${n}`);
  const b2 = bookOf('laixue-2', 10, (n) => `b${n}`);
  const b3 = bookOf('laixue-3', 10, (n) => `c${n}`);
  const setting = { enabled: true, textbookId: 'laixue-2', currentLesson: 3 };

  it('book 2 lesson 3: all of book 1 and book 2 L1–3 covered, only L4 trickles, L5+ out', () => {
    const s = classScope(setting);
    expect(s.courseOrdinal).toBe(13);
    expect(s.currentLesson).toBe(3);
    for (let n = 1; n <= 10; n++) expect(tagsInScope(tbBook('laixue-1', n), s)).toBe(true);
    for (const n of [1, 2, 3, 4]) expect(tagsInScope(tbBook('laixue-2', n), s)).toBe(true);
    for (const n of [5, 6, 10]) expect(tagsInScope(tbBook('laixue-2', n), s)).toBe(false);
    expect(tagsInScope(tbBook('laixue-3', 1), s)).toBe(false);

    const ev = lessonCoveredEvidence([b1, b2, b3], s.courseOrdinal, NOW);
    const ids = ev.filter((e) => e.item.kind === 'word').map((e) => e.item.id);
    expect(ids).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `a${i + 1}`),
      'b1',
      'b2',
      'b3',
    ]);
    expect(ids).not.toContain('b5');
  });

  it('"Lessons ahead of class" is the one preview setting (Phase 21)', () => {
    const none = classScope(setting, { aheadLessons: 0 });
    expect(tagsInScope(tbBook('laixue-2', 4), none)).toBe(false);
    const two = classScope(setting, { aheadLessons: 2 });
    expect(tagsInScope(tbBook('laixue-2', 5), two)).toBe(true);
  });

  it('at the end of a book the next book\'s first lesson is the one that trickles in', () => {
    const s = classScope({ enabled: true, textbookId: 'laixue-1', currentLesson: 10 });
    expect(tagsInScope(tbBook('laixue-2', 1), s)).toBe(true);
    expect(tagsInScope(tbBook('laixue-2', 2), s)).toBe(false);
  });

  it('a word shared by book 1 and book 3 is covered once book 1 is, even if class is in book 2', () => {
    const s = classScope({ enabled: true, textbookId: 'laixue-2', currentLesson: 1 });
    expect(tagsInScope([...tbBook('laixue-1', 8), ...tbBook('laixue-3', 9)], s)).toBe(true);
    // ...but a word new in book 3 is not.
    expect(tagsInScope(tbBook('laixue-3', 9), s)).toBe(false);
  });

  it('new-word candidates: later lessons stay out (Phase 21)', () => {
    const lex = new Lexicon([
      word('a1', '甲', tbBook('laixue-1', 1)),
      word('b3', '乙', tbBook('laixue-2', 3)),
      word('b4', '丙', tbBook('laixue-2', 4)),
      word('b5', '丁', tbBook('laixue-2', 5)),
      word('c1', '戊', tbBook('laixue-3', 1)),
    ]);
    const picked = candidates(lex, [], classScope(setting));
    expect(picked).toContain('b3');
    expect(picked).toContain('a1');
    expect(picked).toContain('b4');
    expect(picked).not.toContain('b5');
    expect(picked).not.toContain('c1');
  });

  it('validator scope for a scenario = course words up to and including its lesson', () => {
    const ids = lessonScopedWordIds([b1, b2, b3], 3, { bookId: 'laixue-2' });
    expect(ids.has('a10')).toBe(true);
    expect(ids.has('b3')).toBe(true);
    expect(ids.has('b4')).toBe(false);
    expect(ids.has('c1')).toBe(false);
  });
});

describe('Phase 12 "My class" setting migrates to (laixue-1, n)', () => {
  it('identical queues for book-1 only profiles', () => {
    const lex = new Lexicon(words);
    for (const n of [1, 4, 10]) {
      const legacy = { enabled: true, textbookId: 'laixue-1', currentLesson: n };
      const s = classScope(legacy);
      expect(s.currentLesson).toBe(n);
      const picked = candidates(lex, [], s);
      const expected = words
        .filter((w) => {
          const l = firstLessonOfTags(w.tags);
          return l === undefined || l <= n + 1;
        })
        .map((w) => w.id);
      expect(new Set(picked)).toEqual(new Set(expected));
    }
  });
});

describe('level filter for textbook content', () => {
  const items = [
    { id: 'a', level: 'N1' as const },
    { id: 'b', level: 'L1' as const },
    { id: 'c', level: 'L2' as const },
    { id: 'd', level: 'L1' as const },
    { id: 'e', level: 'L3' as const },
  ];
  it('shows the chosen level first, easier ones below, hides harder ones', async () => {
    const { filterByLevel, levelFit, classLevelHint } = await import('./level-filter.js');
    expect(filterByLevel(items, (x) => x.level, 'L1').map((x) => x.id)).toEqual(['b', 'd', 'a']);
    expect(filterByLevel(items, (x) => x.level, 'L2').map((x) => x.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(filterByLevel(items, (x) => x.level, 'N1').map((x) => x.id)).toEqual(['a']);
    expect(levelFit('L2', 'L1')).toBe('harder');
    expect(classLevelHint('laixue-2', 3)).toBe('來學華語 2 (A1) ≈ L1 入門級 · A1');
  });
});
