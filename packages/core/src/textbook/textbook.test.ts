import { describe, expect, it } from 'vitest';
import { nextNewItems } from '../curriculum.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import {
  classScope,
  filterIdsInScope,
  firstLessonOfTags,
  lessonBadge,
  lessonCoveredEvidence,
  lessonTag,
  lessonsOfTags,
  tagsInScope,
  textbookTag,
} from './scope.js';
import { lessonProgress } from './progress.js';
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
    expect(lessonBadge(3)).toBe('來學華語 L3');
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

describe('nextNewItems with My class', () => {
  const lexicon = new Lexicon(words);
  const idsOf = (cards: SkillCard[], scope: ReturnType<typeof classScope>, n = 20) =>
    nextNewItems(cards, lexicon, n, { currentLevel: 'N1', classScope: scope }).map((w) => w.id);

  it('current lesson first, next lesson trickles, lessons 6–10 stay out at lesson 4', () => {
    const scope = classScope({ enabled: true, textbookId: 'laixue-1', currentLesson: 4 });
    const cards = lessonCoveredEvidence(book, 3, NOW)
      .filter((e) => e.item.kind === 'word')
      .map((e) => applyEvidence(undefined, e, NOW).card!);
    const picked = idsOf(cards, scope);
    expect(picked[0]).toBe('w4');
    expect(picked).toContain('w5'); // i+1
    for (const out of ['w6', 'w7', 'w8', 'w9', 'w10']) expect(picked).not.toContain(out);
    // The next lesson only arrives after the current one.
    expect(picked.indexOf('w4')).toBeLessThan(picked.indexOf('w5'));
  });

  it('off: identical to a call without the context', () => {
    const off = classScope({ enabled: false, textbookId: 'laixue-1', currentLesson: 4 });
    const a = nextNewItems([], lexicon, 20, { currentLevel: 'N1' }).map((w) => w.id);
    const b = nextNewItems([], lexicon, 20, { currentLevel: 'N1', classScope: off }).map(
      (w) => w.id,
    );
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
  it('counts review-or-better vocab and practised grammar', () => {
    const mk = (kind: 'word' | 'grammar', id: string, state: SkillCard['state']): SkillCard => ({
      item: { kind, id },
      skill: 'recognition',
      card: emptyCard(NOW),
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
    const l = lesson(1, ['a', 'b'], ['gram-1']);
    const p = lessonProgress(l, {
      cards: [
        mk('word', 'a', 'review'),
        mk('word', 'b', 'introduced'),
        mk('grammar', 'gram-1', 'learning'),
      ],
    });
    expect(p.vocabShare).toBe(0.5);
    expect(p.grammarPractised).toBe(1);
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
