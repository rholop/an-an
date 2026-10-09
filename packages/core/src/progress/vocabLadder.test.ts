import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import type { Level } from '../levels.config.js';
import { DEFAULT_STUDY_SETTINGS, getStudyFocus } from '../study/study-focus.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Word } from '../types.js';
import { buildOpenChatVocab } from '../chat/openChat.js';
import { vocabLadder } from './vocabLadder.js';

let n = 0;
const w = (headword: string, level: Level | null, glossEn: string, extra: Partial<Word> = {}): Word => ({
  id: `v${++n}-${headword}`,
  headword,
  variants: [],
  pos: ['N'],
  level,
  source: level ? 'tocfl' : 'supplement',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn,
  chars: [...headword],
  tags: [],
  ...extra,
});

const WORDS: Record<string, Word> = Object.fromEntries(
  [
    w('我', 'N1', 'I'),
    w('你', 'N1', 'you'),
    w('喝', 'N1', 'to drink'),
    w('茶', 'N1', 'tea'),
    w('老師', 'N1', 'teacher'), // lesson 1
    w('學生', 'N1', 'student'), // lesson 2
    w('咖啡', 'N1', 'coffee'), // lesson 3 (the class)
    w('便利商店', 'N1', 'convenience store'), // lesson 4
    w('捷運', 'N1', 'MRT'), // lesson 5
    w('機車', 'N1', 'scooter'), // N1, in no lesson
    w('垃圾車', 'L1', 'garbage truck'), // book 2 (L1, gated while N1 is unmastered)
    w('經濟', 'L4', 'economy'),
    w('王', null, 'Wang', { tags: ['name'] }),
  ].map((x) => [x.headword, x]),
);
const id = (hw: string) => WORDS[hw]!.id;
const lexicon = new Lexicon(Object.values(WORDS), [
  { id: 'gram-le', pattern: 'V + 了', level: 'N1', explanationEn: '', examples: [] },
  { id: 'gram-guo', pattern: 'V + 過', level: 'N1', explanationEn: '', examples: [] },
  { id: 'gram-ba', pattern: '把', level: 'N1', explanationEn: '', examples: [] },
]);

const lesson = (bookId: string, nn: number, over: Partial<Lesson> = {}): Lesson => ({
  id: `${bookId}-L${String(nn).padStart(2, '0')}`,
  n: nn,
  titleZh: '',
  titleEn: `Lesson ${nn}`,
  topic: `Topic ${nn}`,
  objectives: [],
  vocab: [],
  supplementary: [],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
  ...over,
});

const books: Textbook[] = [
  {
    id: 'laixue-1',
    titleZh: '',
    titleEn: '',
    lessons: [
      lesson('laixue-1', 1, { vocab: [id('老師'), id('王')], properNouns: [id('王')], grammar: ['gram-le'] }),
      lesson('laixue-1', 2, { vocab: [id('學生')] }),
      lesson('laixue-1', 3, { vocab: [id('咖啡')], grammar: ['gram-guo'] }),
      lesson('laixue-1', 4, { vocab: [id('便利商店')], grammar: ['gram-ba'] }),
      lesson('laixue-1', 5, { vocab: [id('捷運')] }),
    ],
  },
  { id: 'laixue-2', titleZh: '', titleEn: '', lessons: [lesson('laixue-2', 1, { vocab: [id('垃圾車')] })] },
];

const card = (wordId: string, state: SkillCard['state'], stability = 30): SkillCard => ({
  item: { kind: 'word', id: wordId },
  skill: 'recognition',
  card: { ...createEmptyCard(new Date('2026-01-01')), stability },
  state,
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

const now = new Date('2026-10-08');
/** The seeded profile: My class = Lesson 3; Lessons 1–2 not mastered (catch-up); 我 / 你 / 喝 learned. */
function seeded() {
  const focus = getStudyFocus(
    {
      lexicon,
      books,
      cards: [card(id('我'), 'review'), card(id('你'), 'review'), card(id('喝'), 'review')],
      grammarUses: new Map(),
      settings: { ...DEFAULT_STUDY_SETTINGS },
      myClass: { enabled: true, textbookId: 'laixue-1', currentLesson: 3 },
    },
    now,
  );
  return {
    lexicon,
    level: 'N1' as Level,
    knownIds: new Set([id('我'), id('你'), id('喝')]),
    dueIds: new Set<string>(),
    learningIds: new Set([id('茶')]),
    books,
    studyFocus: focus,
  };
}

describe('vocabLadder (Phase 24 Part A)', () => {
  it('ranks the seeded profile: what you can read, this lesson and catch-up, next, the one after, level, else', () => {
    const p = seeded();
    expect(p.studyFocus.activeLesson?.lessonId).toBe('laixue-1-L03');
    const ladder = vocabLadder(p);
    // rung 1: learned and learning
    for (const hw of ['我', '你', '喝', '茶']) expect(ladder.rung(id(hw)), hw).toBe(1);
    // Phase 29 Part B.10: catch-up lessons' words the learner has never met are being learned (rung 2),
    // never "known"
    for (const hw of ['老師', '學生']) expect(ladder.rung(id(hw)), hw).toBe(2);
    expect(ladder.rung(id('咖啡'))).toBe(2);
    expect(ladder.rung(id('便利商店'))).toBe(3);
    expect(ladder.rung(id('捷運'))).toBe(4);
    expect(ladder.rung(id('機車'))).toBe(5);
    // book 2 is gated (N1 unmastered): never "next"; above the picked level it is rung 6
    expect(ladder.rung(id('垃圾車'))).toBe(6);
    expect(ladder.rung(id('經濟'))).toBe(6);
    expect(ladder.rung('not-a-word')).toBe(6);
    expect(ladder.lessons.active?.lessonId).toBe('laixue-1-L03');
    expect(ladder.lessons.next?.lessonId).toBe('laixue-1-L04');
    expect(ladder.lessons.after?.lessonId).toBe('laixue-1-L05');
    // grammar: learned and active lessons allowed, the next lesson's once at most
    expect(ladder.grammar.allowed).toEqual(['gram-le', 'gram-guo']);
    expect(ladder.grammar.next).toEqual(['gram-ba']);
    expect(ladder.properNounIds).toEqual([id('王')]);
  });

  it('each word sits on its lowest rung only', () => {
    const p = { ...seeded(), knownIds: new Set([id('咖啡'), id('便利商店')]) };
    const ladder = vocabLadder(p);
    expect(ladder.rung(id('咖啡'))).toBe(1);
    expect(ladder.ids[2].has(id('咖啡'))).toBe(false);
    expect(ladder.ids[3].has(id('便利商店'))).toBe(false);
  });

  it('a gated lesson is not "next"; a mastered one does not take a place', () => {
    const p = seeded();
    const ladder = vocabLadder({ ...p, studyFocus: { ...p.studyFocus, masteredLessonIds: ['laixue-1-L04'] } });
    expect(ladder.lessons.next?.lessonId).toBe('laixue-1-L05');
    expect(ladder.lessons.after).toBeUndefined(); // book 2 is gated
    expect(ladder.rung(id('垃圾車'))).toBe(6);
  });

  it('study order off: rungs 2–4 are empty, the level still counts', () => {
    const p = seeded();
    const ladder = vocabLadder({ ...p, studyFocus: { ...p.studyFocus, enabled: false } });
    expect(ladder.source).toBe('none');
    expect(ladder.rung(id('咖啡'))).toBe(5);
    expect(ladder.rung(id('老師'))).toBe(5); // no catch-up without the study order
  });

  it('Phase 18 open chat ranks words with the same ladder (A = rungs 1–4, B = rung 5, C = rung 6)', () => {
    const p = seeded();
    const ladder = vocabLadder(p);
    const vocab = buildOpenChatVocab(p, { text: '' }, now);
    for (const x of Object.values(WORDS)) {
      const r = ladder.rung(x.id);
      const tier = vocab.tierAIds.has(x.id) ? 'A' : vocab.tierBIds.has(x.id) ? 'B' : 'C';
      expect(tier, x.headword).toBe(r <= 4 ? 'A' : r === 5 ? 'B' : 'C');
    }
  });
});
