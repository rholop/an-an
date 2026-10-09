import { describe, expect, it } from 'vitest';
import {
  buildMixedSession,
  buildSession,
  emptyCard,
  isOrderedSession,
  Lexicon,
  planListenSession,
  type Lesson,
  type SkillCard,
  type Word,
} from '@anan/core';
import { buildQuickCheck } from '../components/QuickKnownCheck.js';
import { buildReviewSession, lessonSessionCards, pickReviewCards } from './review-session.js';
import { buildLessonGrammarStep } from './textbook-session.js';

const NOW = new Date('2026-10-07T12:00:00Z');

const word = (id: string, headword: string): Word => ({
  id,
  headword,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: id,
  chars: [...headword],
  tags: [],
});

const HEADWORDS = ['捷運', '機車', '便利商店', '垃圾車', '老師', '學生', '咖啡', '茶', '朋友', '臺灣'];
const WORDS = HEADWORDS.map((h, i) => word(`w${i + 1}`, h));
const lex = new Lexicon(WORDS);

const card = (id: string, skill: SkillCard['skill'], reps = 0): SkillCard => ({
  item: { kind: 'word', id },
  skill,
  card: { ...emptyCard(NOW), reps },
  state: reps === 0 ? 'introduced' : 'review',
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

const lesson: Lesson = {
  id: 'laixue-1-L01',
  n: 1,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: WORDS.map((w) => w.id),
  supplementary: [],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
};

describe('lesson session (Phase 19)', () => {
  // Starting a lesson introduces both cards of every word, all due now.
  const due = WORDS.flatMap((w) => [card(w.id, 'recognition'), card(w.id, 'production')]);

  it('10 new words: only recognition cards, not in book order', () => {
    const recog = due.filter((c) => c.skill === 'recognition');
    const s = lessonSessionCards({ due: [], newCards: recog, lesson, hasCard: () => true, allowedNew: 10 });
    const ordered = buildReviewSession({ due: s.due, fresh: s.fresh, seed: 'lesson-1' });
    expect(ordered).toHaveLength(10);
    expect(ordered.every((c) => c.skill === 'recognition')).toBe(true);
    expect(ordered.map((c) => c.item.id)).not.toEqual(WORDS.map((w) => w.id));
  });

  it('Phase 21: "Study this lesson" introduces words with no card yet, and takes Due cards of both skills', () => {
    const answered = [card('w1', 'recognition', 3), card('w1', 'production', 2), card('zz', 'recognition', 3)];
    const s = lessonSessionCards({
      due: answered,
      newCards: [],
      lesson,
      hasCard: (i) => i.id === 'w1',
      allowedNew: 4,
    });
    expect(s.due.map((c) => `${c.item.id}:${c.skill}`)).toEqual(['w1:recognition', 'w1:production']);
    expect(s.newItems.map((i) => i.id)).toEqual(['w2', 'w3', 'w4', 'w5']);
    // paused (allowance 0): only the due cards
    expect(lessonSessionCards({ due: answered, newCards: [], lesson, hasCard: () => false, allowedNew: 0 }).newItems).toEqual([]);
  });

  it('Phase 21: New cards are capped in Review like new items (My class cards no longer uncapped)', () => {
    const newCards = WORDS.map((w) => card(w.id, 'recognition'));
    const r = pickReviewCards({ due: [], newCards, doneThisSession: 0, cap: 80, now: NOW, allowance: { state: 'open', allowed: 3, faces: 8 } });
    expect(r.fresh).toHaveLength(3);
    expect(r.due).toHaveLength(0);
  });

  it('the normal review screen never shows a word’s two cards side by side, and new production follows recognition', () => {
    for (let s = 0; s < 100; s++) {
      const ordered = buildReviewSession({ due, seed: `review-${s}` });
      const last = new Map<string, number>();
      const recognised = new Set<string>();
      ordered.forEach((c, i) => {
        const prev = last.get(c.item.id);
        if (prev !== undefined) expect(i - prev).toBeGreaterThan(5);
        last.set(c.item.id, i);
        if (c.skill === 'recognition') recognised.add(c.item.id);
        else expect(recognised.has(c.item.id)).toBe(true);
      });
    }
  });
});

describe('every session builder uses orderSession (Phase 19)', () => {
  const due = WORDS.flatMap((w) => [card(w.id, 'recognition', 3), card(w.id, 'production', 3)]);
  const clozeOpts = {
    lexicon: lex,
    knownIds: new Set<string>(),
    learnerLevel: 'N1' as const,
    journalSentences: [],
    chatLines: [],
    bankSentences: [],
    seed: 'x',
  };

  it('review screen', () => {
    expect(isOrderedSession(buildReviewSession({ due, seed: 'x' }))).toBe(true);
  });
  it('cloze session', () => {
    expect(isOrderedSession(buildSession(due, clozeOpts))).toBe(true);
    expect(isOrderedSession(buildMixedSession(due, { ...clozeOpts, errorItems: [], now: NOW }))).toBe(true);
  });
  it('listening session', () => {
    const plan = planListenSession({
      lexicon: lex,
      dueListening: [],
      newWordIds: ['w1'],
      newAllowed: 4,
      hasClip: () => true,
      sentences: [],
      seed: 'x',
    });
    expect(isOrderedSession(plan)).toBe(true);
  });
  it('lesson grammar step: its own rule (Phase 25), round-robin and never deferred, not the flashcard order', () => {
    const { plan } = buildLessonGrammarStep({ n: 1, grammar: [] }, [], [], { lexicon: lex, seed: 'x' });
    expect(isOrderedSession(plan.exercises)).toBe(false);
    expect(plan.exercises).toEqual([]);
  });
  it('lesson quick check', () => {
    expect(isOrderedSession(buildQuickCheck(lesson, lex, [], [], 'x'))).toBe(true);
  });
});
