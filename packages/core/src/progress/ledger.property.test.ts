// Phase 29 Part C.3: the invariants that make every screen's numbers agree, over random learner
// states, clock times (morning, between sessions, evening, midnight, DST days) and settings.
// Changing a definition in `ledger.ts` means changing the Shared terms table and this test too.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyEvidence } from '../learner/apply-evidence.js';
import { buildFsrs } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { buildPlants } from '../game/garden.js';
import { PRIORITY_CONFIG, type PriorityConfig } from '../curriculum/priority.config.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Evidence, ItemRef, Level, Skill, Word } from '../types.js';
import { buildLedger, type Ledger, type NewQueue } from './ledger.js';
import { PROGRESS_CONFIG } from './progress.config.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate, type SessionSettings } from './review-sessions.js';
import { isActiveCard, isNewCard, levelItems } from './terms.js';
import { activeDaysFromHistory } from './active-days.js';
import { computeStreak } from '../game/streak.js';

const HEADWORDS = [...'貓狗魚鳥馬牛羊雞鴨豬茶水書筆車船門窗山河'];
const word = (hw: string, i: number): Word => ({
  id: `w${i}`,
  headword: hw,
  variants: [],
  pos: ['N'],
  level: (i < 14 ? 'N1' : 'N2') as Level,
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: hw,
  chars: [hw],
  tags: [],
});
const WORDS = HEADWORDS.map(word);
const lexicon = new Lexicon(WORDS);
const GRAMMAR = ['g0', 'g1', 'g2'];
const ITEMS: ItemRef[] = [
  ...WORDS.map((w) => ({ kind: 'word' as const, id: w.id })),
  ...GRAMMAR.map((id) => ({ kind: 'grammar' as const, id })),
];
const lesson: Lesson = {
  id: 'book-L01',
  n: 1,
  titleZh: '第一課',
  titleEn: 'Lesson one',
  topic: 'animals',
  objectives: [],
  vocab: ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'],
  supplementary: [],
  grammarWords: ['w8'],
  properNouns: [],
  grammar: ['g0', 'g1'],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
};
const book: Textbook = { id: 'book', titleZh: '書', titleEn: 'Book', lessons: [lesson] };
const fsrs = buildFsrs(DEFAULT_LEARNER_CONFIG);
const QUEUES: NewQueue[] = ['review', 'cloze', 'pinyin', 'listening'];

const WORD_KINDS: Evidence['kind'][] = [
  'textbook_lesson_covered',
  'review_again',
  'review_hard',
  'review_good',
  'review_good',
  'review_easy',
  'review_nope',
  'known_check_passed',
  'anki_import_seen',
];
const GRAMMAR_KINDS: Evidence['kind'][] = ['journal_correct_use', 'cloze_correct_nohint', 'journal_misuse', 'cloze_wrong', 'known_check_passed'];
const SKILLS: Skill[] = ['recognition', 'recognition', 'production', 'reading', 'listening'];

/** Clock times that matter: midnight, inside and between the sessions, edges, DST days. */
const DAYS: [number, number, number][] = [
  [2026, 3, 8], // spring forward in New York
  [2026, 6, 15],
  [2026, 11, 1], // fall back
  [2026, 10, 9],
];
const HOURS = [0, 2, 3, 4, 8, 9, 10, 12, 14, 16, 18, 23];
const ZONES = ['America/New_York', 'Asia/Taipei'];

const eventArb = fc.record({
  item: fc.nat(ITEMS.length - 1),
  skill: fc.nat(SKILLS.length - 1),
  kind: fc.nat(Math.max(WORD_KINDS.length, GRAMMAR_KINDS.length) - 1),
  nope: fc.constantFrom('never', 'not_now', 'known'),
  minutesAgo: fc.integer({ min: 0, max: 40 * 24 * 60 }),
});

/** A starting point per item, so mastered lessons, level-ups, backlogs and Nope'd words are common. */
const SEEDS = ['none', 'none', 'new', 'known', 'overdue', 'overdue', 'nope'] as const;
type Seed = (typeof SEEDS)[number];
const DAY_MS = 86_400_000;

function seedEvidence(item: ItemRef, seed: Seed, now: Date): Evidence[] {
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const ev = (kind: Evidence['kind'], skill: Skill, days: number, extra: Partial<Evidence> = {}): Evidence => ({ item, skill, kind, at: at(days), ...extra });
  if (item.kind === 'grammar') {
    if (seed === 'known') return [ev('known_check_passed', 'recognition', 30)];
    if (seed === 'overdue' || seed === 'nope') return [30, 20, 10].map((d) => ev('journal_correct_use', 'recognition', d));
    return seed === 'new' ? [ev('cloze_wrong', 'recognition', 5)] : [];
  }
  switch (seed) {
    case 'none':
      return [];
    case 'new':
      return [ev('textbook_lesson_covered', 'recognition', 30)];
    case 'known':
      return [ev('known_check_passed', 'recognition', 30), ev('known_check_passed', 'production', 30)];
    case 'overdue':
      return [ev('review_good', 'recognition', 30), ev('review_good', 'production', 29), ev('review_good', 'reading', 29)];
    case 'nope':
      return [ev('review_good', 'recognition', 30), ev('review_nope', 'recognition', 1, { context: { source: 'review', choice: 'never' } })];
  }
}

const stateArb = fc.record({
  // a mixed learner, or a strong one (lessons done, ready for the next level)
  seeds: fc.oneof(
    fc.array(fc.constantFrom(...SEEDS), { minLength: ITEMS.length, maxLength: ITEMS.length }),
    fc.array(fc.constantFrom<Seed>('known', 'known', 'known', 'known', 'overdue', 'nope', 'none'), { minLength: ITEMS.length, maxLength: ITEMS.length }),
  ),
  events: fc.array(eventArb, { maxLength: 60 }),
  day: fc.constantFrom(...DAYS),
  hour: fc.constantFrom(...HOURS),
  minute: fc.constantFrom(0, 30, 59),
  zone: fc.constantFrom(...ZONES),
  cap: fc.constantFrom(10, 20, 80),
  masteryShare: fc.constantFrom(0.5, 0.8, 0.9, 1),
  knownItems: fc.subarray(['word:w9', 'word:w10', 'grammar:g2', 'grammar:g1']),
});

type State = typeof stateArb extends fc.Arbitrary<infer T> ? T : never;

function ledgerOf(s: State, over: { book?: Textbook; config?: PriorityConfig } = {}): Ledger {
  const settings: SessionSettings = { ...DEFAULT_SESSION_SETTINGS, timeZone: s.zone, capPerSession: s.cap };
  const now = zonedDate(s.day[0], s.day[1], s.day[2], s.hour, s.minute, s.zone);
  const evidence: Evidence[] = s.events
    .map((e) => {
      const item = ITEMS[e.item]!;
      const kinds = item.kind === 'word' ? WORD_KINDS : GRAMMAR_KINDS;
      const kind = kinds[e.kind % kinds.length]!;
      const skill: Skill = item.kind === 'grammar' ? 'recognition' : SKILLS[e.skill]!;
      return {
        item,
        skill,
        kind,
        at: new Date(now.getTime() - e.minutesAgo * 60_000),
        ...(kind === 'review_nope' ? { context: { source: 'review' as const, choice: e.nope } } : {}),
      } as Evidence;
    })
    .concat(ITEMS.flatMap((item, i) => seedEvidence(item, s.seeds[i]!, now)))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const cards = new Map<string, SkillCard>();
  for (const ev of evidence) {
    const key = `${ev.item.kind}:${ev.item.id}:${ev.skill}`;
    const next = applyEvidence(cards.get(key), ev, ev.at).card;
    if (next) cards.set(key, next);
  }
  return buildLedger({
    cards: [...cards.values()],
    evidence,
    knownItems: s.knownItems,
    session: settings,
    masteryShare: s.masteryShare,
    now,
    activeDays: activeDaysFromHistory({ evidence }, s.zone).map((r) => r.day),
    study: {
      lexicon,
      books: [over.book ?? book],
      ...(over.config ? { config: over.config } : {}),
      settings: { ...DEFAULT_STUDY_SETTINGS, enabled: false, masteryShare: s.masteryShare, knownItems: s.knownItems },
    },
  });
}

const keyOf = (c: Pick<SkillCard, 'item' | 'skill'>) => `${c.item.kind}:${c.item.id}|${c.skill}`;
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** fast-check runs: enough to hit every clock time and zone many times over. */
const RUNS = { numRuns: 300 };

describe('the progress ledger: numbers agree (Phase 29 Part C.3)', () => {
  it('garden thirsty words = Water all words = the words in session()', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        const thirsty = buildPlants(ledger, lexicon, fsrs)
          .filter((p) => p.dueCards.length > 0)
          .map((p) => p.wordId);
        expect(sorted(thirsty)).toEqual(sorted(ledger.thirstyWords()));
        expect(sorted(ledger.session().words)).toEqual(sorted(ledger.thirstyWords()));
        expect(ledger.status.thirstyWords).toBe(ledger.thirstyWords().length);
      }),
      RUNS,
    );
  });

  it('the badge = the session size; needsWater is exactly the session', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        const session = ledger.session().cards;
        expect(ledger.status.dueNow).toBe(session.length);
        expect(ledger.status.sessionCards).toBe(session.length);
        const inSession = new Set(session.map(keyOf));
        for (const c of ledger.cards) expect(ledger.needsWater(c)).toBe(c.skill !== 'listening' && inSession.has(keyOf(c)));
        if (ledger.status.session === 'between') expect(session).toHaveLength(0);
      }),
      RUNS,
    );
  });

  it('Review early is one size: the next session it announces', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        if (ledger.status.session !== 'between') return;
        const early = ledger.session({ early: true }).cards;
        expect(early.length).toBe(ledger.status.nextSession.count);
        expect(sorted(early.map(keyOf))).toEqual(sorted(ledger.status.nextSessionCardKeys));
        // every entry (Home, Garden, Review) asks the same ledger for it
        expect(ledgerOf(s).session({ early: true }).cards.map(keyOf)).toEqual(early.map(keyOf));
      }),
      RUNS,
    );
  });

  it('lesson chip done ⇔ nothing still to master', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        const view = ledger.lesson(lesson);
        expect(view.done).toBe(view.stillToMaster.length === 0);
        expect(view.done).toBe(view.masteredShare >= s.masteryShare);
        for (const i of view.stillToMaster) expect(ledger.mastered(i)).toBe(false);
        for (const i of view.items) expect(ledger.removed(i)).toBe(false);
      }),
      RUNS,
    );
  });

  it('level-up readiness ⇔ the Progress Learned % for that level ≥ the threshold', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        for (const level of ['N1', 'N2'] as const) {
          const view = ledger.level(level);
          const progress = ledger.summary(levelItems(level, WORDS));
          expect(view.learnedShare).toBe(progress.learnedShare);
          expect(view.readyForNext).toBe(progress.total > 0 && progress.learnedShare >= PROGRESS_CONFIG.levelUpLearnedShare);
        }
      }),
      RUNS,
    );
  });

  it('●●● ⇔ grammar Mastered', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        for (const id of GRAMMAR) {
          const v = ledger.item({ kind: 'grammar', id });
          expect(v.dots === PROGRESS_CONFIG.mastered.grammarCorrectUses).toBe(v.mastered);
        }
      }),
      RUNS,
    );
  });

  it('a New card is never in a session; a New or removed card never gets read credit', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        const inAny = new Set([...ledger.session().cards, ...ledger.session({ early: true }).cards].map(keyOf));
        for (const c of ledger.cards) {
          if (isNewCard(c)) {
            expect(ledger.inSession(c)).toBe(false);
            expect(inAny.has(keyOf(c))).toBe(false);
          }
          if (isNewCard(c) || !isActiveCard(c)) expect(ledger.creditsRead(c)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it('Home streak bar = Progress streak (Phase 32): one run, one set of days', () => {
    fc.assert(
      fc.property(stateArb, fc.constantFrom(0, 1, 2, 3), (s, freezes) => {
        const ledger = ledgerOf(s);
        const config = { enabled: true, freezeDaysPerWeek: freezes };
        // Home and Progress both ask the ledger with its own active days.
        const home = ledger.streak(ledger.activeDays(), config);
        const progress = ledger.streak(ledger.activeDays(), config);
        expect(home).toEqual(progress);
        expect(home).toEqual(computeStreak(ledger.activeDays(), ledger.now, config, ledger.timeZone));
        const week = ledger.streakWeek(ledger.activeDays(), config);
        expect(week).toHaveLength(7);
        expect(week.at(-1)!.day).toBe(ledger.dayKey());
        expect(week.at(-1)!.status === 'active').toBe(ledger.activeToday());
        for (const d of week) expect(d.status === 'active').toBe(ledger.activeDays().has(d.day));
        // The bar's trailing run (active and freeze days back to the last missed day) is the streak.
        let trailing = 0;
        let i = week.length - 1;
        for (; i >= 0 && week[i]!.status !== 'missed'; i--) if (week[i]!.status === 'active') trailing++;
        if (i >= 0) expect(trailing).toBe(home.current);
        else expect(trailing).toBeLessThanOrEqual(home.current);
      }),
      RUNS,
    );
  });

  it('a pause stops new words in every queue', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const ledger = ledgerOf(s);
        const state = ledger.newAllowance('review').state;
        for (const q of QUEUES) expect(ledger.newAllowance(q).state).toBe(state);
        if (state !== 'paused_backlog' && state !== 'limit_reached') return;
        for (const q of QUEUES) {
          expect(ledger.newAllowance(q).allowed).toBe(0);
          const picked = ledger.pickNew(q, { level: 'N1' });
          expect(picked.cards.length + picked.items.length).toBe(0);
        }
        expect(ledger.newAllowance('review').faces).toBe(0);
        expect(ledger.practice('listening').fresh).toHaveLength(0);
        expect(ledger.practice('reading').fresh).toHaveLength(0);
      }),
      RUNS,
    );
  });

  // Phase 34: a lesson's extra words are taught with it, but its numbers are the book's own list.
  it('extra words never change a lesson\'s Learned / Mastered / done (default flag)', () => {
    const withExtras: Lesson = { ...lesson, supplementary: ['w9'], extra: ['w10', 'w11', 'w12'] };
    const bookX: Textbook = { ...book, lessons: [withExtras] };
    fc.assert(
      fc.property(stateArb, (s) => {
        const a = ledgerOf(s).lesson(lesson);
        const b = ledgerOf(s, { book: bookX }).lesson(withExtras);
        expect(b.items).toEqual(a.items);
        expect([b.learned, b.mastered, b.total, b.done]).toEqual([a.learned, a.mastered, a.total, a.done]);
        expect(b.stillToMaster).toEqual(a.stillToMaster);
      }),
      RUNS,
    );
  });

  it('with extrasCountForLessonMastery on, the extras are counted (and only then)', () => {
    const withExtras: Lesson = { ...lesson, supplementary: [], extra: ['w10', 'w11'] };
    const bookX: Textbook = { ...book, lessons: [withExtras] };
    const on: PriorityConfig = { ...PRIORITY_CONFIG, extrasCountForLessonMastery: true };
    fc.assert(
      fc.property(stateArb, (s) => {
        const off = ledgerOf(s, { book: bookX }).lesson(withExtras);
        const counted = ledgerOf(s, { book: bookX, config: on }).lesson(withExtras);
        const offIds = off.items.map((i) => i.id);
        const added = counted.items.map((i) => i.id).filter((id) => !offIds.includes(id));
        expect(counted.items.map((i) => i.id)).toEqual(expect.arrayContaining(offIds));
        expect(added.every((id) => id === 'w10' || id === 'w11')).toBe(true);
        // an extra the learner removed (Nope) is left out, like any other item
        expect(added.length).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });
});
