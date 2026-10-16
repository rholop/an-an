// Phase 39/40/42, replaced by Phase 43 (owner, 2026-10-16): a saved class's words go first, inside one
// daily limit on new words (15) and new card types (25), half in the morning; a word's faces follow
// Meaning → Pick → Say it, each released by Good/Easy in two different sessions and entering from the
// session after; a session is fixed at its first answer; a session holds at most 40 cards.
import { describe, expect, it } from 'vitest';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import { tutorIntroduceEvidence, type TutorLesson } from '../tutor/session.js';
import type { Evidence, Word } from '../types.js';
import { buildLedger, type Ledger } from './ledger.js';
import { PROGRESS_CONFIG } from './progress.config.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate } from './review-sessions.js';

const TZ = 'America/New_York';
const ny = (day: number, h: number, m = 0) => zonedDate(2026, 10, day, h, m, TZ);
const word = (id: string): Word => ({
  id,
  headword: id,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: id,
  chars: [id],
  tags: [],
});
const tutorIds = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const lesson: Lesson = {
  id: 'book-L01',
  n: 1,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: Array.from({ length: 10 }, (_, i) => `b${i}`),
  supplementary: [],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
};
const book: Textbook = { id: 'book', titleZh: '', titleEn: '', lessons: [lesson] };
const lexicon = new Lexicon([...lesson.vocab, ...tutorIds(30)].map(word));

function ledgerAt(now: Date, evidence: Evidence[], tutorLessons: TutorLesson[], lex: Lexicon = lexicon): Ledger {
  const cards = new Map<string, SkillCard>();
  for (const ev of [...evidence].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const key = `${ev.item.kind}:${ev.item.id}|${ev.skill}`;
    const next = applyEvidence(cards.get(key), ev, ev.at).card;
    if (next) cards.set(key, next);
  }
  return buildLedger({
    cards: [...cards.values()],
    evidence,
    knownItems: [],
    session: { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ },
    masteryShare: 0.8,
    now,
    study: {
      lexicon: lex,
      books: [book],
      myClass: { enabled: true, textbookId: 'book', currentLesson: 1 },
      settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true },
      tutorLessons,
    },
  });
}

/** What Save does: introduce what the ledger says, now. */
function save(now: Date, evidence: Evidence[], tutorLessons: TutorLesson[], lex: Lexicon = lexicon): Evidence[] {
  return [...evidence, ...tutorIntroduceEvidence(ledgerAt(now, evidence, tutorLessons, lex).tutorToIntroduce(), now)];
}

const r = (id: string, skill: Evidence['skill'], kind: Evidence['kind'], at: Date): Evidence => ({ item: { kind: 'word', id }, skill, kind, at });
const freshIds = (l: Ledger, skill: Evidence['skill'] = 'recognition') => l.session().fresh.filter((c) => c.skill === skill).map((c) => c.item.id);
const words = PROGRESS_CONFIG.newPerDay.words;
const morningWords = Math.ceil(words * PROGRESS_CONFIG.morningNewShare);

describe('Phase 43 Part A: one daily limit on new words, tutoring words first', () => {
  it('6 tutoring words + textbook words on one day: tutoring first, then the textbook, never more than the limit', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(6), grammarIds: [] }];
    const ev = save(ny(13, 8), [], tutor);
    const morning = ledgerAt(ny(13, 8, 5), ev, tutor);
    expect(ledgerAt(ny(13, 8, 5), ev, tutor).tutorIntroducedThisSession()).toBe(6);
    // Save made Meaning cards only (Part B: later faces wait)
    expect(morning.session().cards.every((c) => c.skill === 'recognition')).toBe(true);
    expect(freshIds(morning)).toEqual(tutorIds(6));
    // the morning's share is half the day's words: the textbook gets what is left of it
    expect(morning.newAllowance('review').allowed).toBe(morningWords - 6);
    const picked = morning.pickNew('review');
    expect(picked.items.length).toBe(morningWords - 6);
    expect(picked.items.some((x) => tutorIds(6).includes(x.id))).toBe(false);
    expect(morning.newToday()).toEqual({ wordsLeft: words, facesLeft: PROGRESS_CONFIG.newPerDay.faces });
    // all started in the morning: the evening gets the rest of the day's limit
    const answered = [...ev, ...[...tutorIds(6), ...picked.items.map((i) => i.id)].map((id) => r(id, 'recognition', 'review_good', ny(13, 8, 30)))];
    const evening = ledgerAt(ny(13, 17), answered, tutor);
    expect(evening.newToday().wordsLeft).toBe(words - morningWords);
    expect(evening.newAllowance('review').allowed).toBe(words - morningWords);
  });

  it(`a 30-word upload starts ${words} words a day over two days, oldest class first`, () => {
    const tutor: TutorLesson[] = [
      { id: 'tutor-old', date: '2026-10-12T07:00', wordIds: tutorIds(30).slice(20), grammarIds: [] },
      { id: 'tutor-new', date: '2026-10-13T07:00', wordIds: tutorIds(20), grammarIds: [] },
    ];
    let ev = save(ny(13, 7), [], tutor);
    const started: string[] = [];
    const sessions = [ny(13, 8), ny(13, 17), ny(14, 8), ny(14, 17), ny(15, 8)];
    for (const at of sessions) {
      const l = ledgerAt(at, ev, tutor);
      const ids = freshIds(l);
      started.push(...ids);
      ev = [...ev, ...ids.map((id) => r(id, 'recognition', 'review_good', new Date(at.getTime() + 60_000)))];
    }
    // day 1: 8 + 7, day 2: 8 + 7 (all 30), the older class first
    expect(started.slice(0, 10)).toEqual(tutorIds(30).slice(20));
    expect(started).toHaveLength(30);
    expect(new Set(started).size).toBe(30);
    const perDay = (day: number) => started.filter((_, i) => (i < 15 ? 13 : 14) === day).length;
    expect(perDay(13)).toBe(words);
  });

  it('a session never holds more than the ceiling, new cards included', () => {
    const others = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const lex = new Lexicon([...lesson.vocab, ...tutorIds(30), ...others].map(word));
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    // 30 cards due; last evening's session was done (no skipped sessions)
    const old: Evidence[] = [...others.slice(0, 30).map((id) => r(id, 'recognition', 'review_good', ny(1, 8))), r('c99', 'recognition', 'review_good', ny(12, 20))];
    const ev = save(ny(13, 8), old, tutor, lex);
    const ledger = ledgerAt(ny(13, 8, 1), ev, tutor, lex);
    const cap = DEFAULT_SESSION_SETTINGS.capPerSession;
    expect(ledger.status.sessionCards).toBeLessThanOrEqual(cap);
    expect(ledger.status.newCards).toBe(Math.min(morningWords, cap - 30));
  });

  it('nothing is introduced for a word already carded, Learned or removed', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: ['b0', 't0'], grammarIds: [] }];
    const known: Evidence = { item: { kind: 'word', id: 'b0' }, skill: 'recognition', kind: 'known_check_passed', at: ny(1, 8) };
    const ledger = ledgerAt(ny(13, 8), [known], tutor);
    expect(ledger.tutorToIntroduce().map((x) => x.item.id)).toEqual(['t0']);
  });
});

describe('Phase 43 Part B: card types enter in order, one stage at a time', () => {
  const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(1), grammarIds: [] }];
  const pickIn = (l: Ledger) => l.session().cards.some((c) => c.skill === 'production');

  it('one Good on Meaning: Pick is not in this session or the next', () => {
    let ev = save(ny(13, 8), [], tutor);
    ev = save(ny(13, 8, 20), [...ev, r('t0', 'recognition', 'review_good', ny(13, 8, 10))], tutor);
    expect(pickIn(ledgerAt(ny(13, 8, 30), ev, tutor))).toBe(false);
    ev = save(ny(13, 17), ev, tutor);
    expect(pickIn(ledgerAt(ny(13, 17), ev, tutor))).toBe(false);
    expect(ledgerAt(ny(13, 17), ev, tutor).cards.some((c) => c.skill === 'production')).toBe(false);
  });

  it('Good in two sessions: Pick enters in the next session, not the one that released it', () => {
    let ev = save(ny(13, 8), [], tutor);
    ev = [...ev, r('t0', 'recognition', 'review_good', ny(13, 8, 10))];
    // a second Good in the same session doesn't count twice
    ev = save(ny(13, 8, 40), [...ev, r('t0', 'recognition', 'review_good', ny(13, 8, 35))], tutor);
    expect(pickIn(ledgerAt(ny(13, 8, 45), ev, tutor))).toBe(false);
    ev = save(ny(13, 17, 10), [...ev, r('t0', 'recognition', 'review_easy', ny(13, 17, 5))], tutor);
    const evening = ledgerAt(ny(13, 17, 15), ev, tutor);
    expect(evening.cards.some((c) => c.skill === 'production')).toBe(true); // made, but waiting
    expect(pickIn(evening)).toBe(false);
    expect(pickIn(ledgerAt(ny(14, 8), ev, tutor))).toBe(true);
    // Say it waits for Pick in the same way
    expect(ledgerAt(ny(14, 8), ev, tutor).session().cards.some((c) => c.skill === 'reading')).toBe(false);
  });

  it('Again or Hard resets the run', () => {
    let ev = save(ny(13, 8), [], tutor);
    ev = [
      ...ev,
      r('t0', 'recognition', 'review_good', ny(13, 8, 10)),
      r('t0', 'recognition', 'review_hard', ny(13, 17, 5)),
      r('t0', 'recognition', 'review_good', ny(14, 8, 5)),
    ];
    ev = save(ny(14, 8, 10), ev, tutor);
    expect(pickIn(ledgerAt(ny(14, 17), ev, tutor))).toBe(false);
    ev = save(ny(14, 17, 10), [...ev, r('t0', 'recognition', 'review_good', ny(14, 17, 5))], tutor);
    expect(pickIn(ledgerAt(ny(15, 8), ev, tutor))).toBe(true);
  });
});

describe('Phase 43 Part C: a session is fixed when it starts, and holds until you do it', () => {
  const lex = new Lexicon([...lesson.vocab, ...tutorIds(30), ...Array.from({ length: 30 }, (_, i) => `d${i}`)].map(word));
  const dueIds = Array.from({ length: 30 }, (_, i) => `d${i}`);
  // 30 cards answered 3 days ago, due this morning
  const old = dueIds.map((id) => r(id, 'recognition', 'review_good', ny(10, 8)));
  const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-12T07:00', wordIds: tutorIds(20), grammarIds: [] }];
  const at = (now: Date, ev: Evidence[], fixed?: ReturnType<Ledger['sessionToFix']>) => {
    const l = ledgerAt(now, ev, tutor, lex);
    return fixed ? buildLedger({ ...ledgerInputsOf(l, ev), fixedSessions: [fixed] }) : l;
  };
  function ledgerInputsOf(l: Ledger, evidence: Evidence[]) {
    return {
      cards: [...l.cards],
      evidence,
      knownItems: [],
      session: l.settings,
      masteryShare: 0.8,
      now: l.now,
      study: { lexicon: lex, books: [book], myClass: { enabled: true, textbookId: 'book', currentLesson: 1 }, settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true }, tutorLessons: tutor },
    };
  }

  it('answer 10 of 30: no new card joins; the session keeps only its own cards', () => {
    const ev0 = save(ny(13, 7), old, tutor, lex);
    // a quiet history: last evening's session was done
    const ev = [...ev0, r('d0', 'recognition', 'review_good', ny(12, 20))];
    const start = at(ny(13, 8), ev);
    const fixed = start.sessionToFix()!;
    expect(fixed.key).toBe('2026-10-13:morning');
    const before = start.session();
    expect(before.fresh.length).toBe(morningWords);
    const done = before.cards.filter((c) => c.card.reps > 0).slice(0, 10);
    const ev2 = [...ev, ...done.map((c) => r(c.item.id, 'recognition', 'review_good', ny(13, 8, 30)))];
    const after = at(ny(13, 8, 40), ev2, fixed);
    expect(after.status.started).toBe(true);
    expect(after.session().fresh.map((c) => c.item.id)).toEqual(before.fresh.map((c) => c.item.id));
    expect(after.status.sessionCards).toBe(before.cards.length - 10);
    expect(after.newAllowance('review').allowed).toBe(0);
    expect(after.status.newMessage).toMatch(/start of a session/);
  });

  it('a skipped morning: the evening offers only its own share; two skipped: no new words until the backlog is done', () => {
    // last answers on the 12th's evening; 29 cards due, no answers in the morning of the 13th
    const ev = save(ny(13, 7), [...old, r('d0', 'recognition', 'review_good', ny(12, 20))], tutor, lex);
    const evening = at(ny(13, 17), ev);
    expect(evening.session().fresh.length).toBe(words - morningWords);
    // skipped both the 13th's evening and the 14th's morning: nothing new in the 14th's evening
    const later = at(ny(14, 17), ev);
    expect(later.status.newState).toBe('paused_backlog');
    expect(later.session().fresh).toHaveLength(0);
    expect(later.session().cards.length).toBeGreaterThan(0);
    // backlog done in that session: the next session has new words again
    const cleared = [...ev, ...dueIds.map((id) => r(id, 'recognition', 'review_good', ny(14, 17, 30)))];
    expect(at(ny(15, 8), cleared).session().fresh.length).toBeGreaterThan(0);
  });
});

describe('Phase 43 Part E: Again comes back later, and the third one waits for the next session', () => {
  it('a card answered Again three times this session is out of it, and in the next one', () => {
    const lex = new Lexicon(['a'].map(word));
    const ev = [r('a', 'recognition', 'review_good', ny(10, 8))];
    const agains = [5, 10, 15].map((m) => r('a', 'recognition', 'review_again', ny(13, 8, m)));
    const two = ledgerAt(ny(13, 8, 12), [...ev, ...agains.slice(0, 2)], [], lex);
    expect(two.session().cards.map((c) => c.item.id)).toEqual(['a']);
    const three = ledgerAt(ny(13, 8, 20), [...ev, ...agains], [], lex);
    expect(three.session().cards).toHaveLength(0);
    expect(ledgerAt(ny(13, 17), [...ev, ...agains], [], lex).session().cards.map((c) => c.item.id)).toEqual(['a']);
  });
});

describe('Phase 42: the Rate your words queue', () => {
  it('lists seen cards the learner has not rated, a word\'s faces together; rating drops them', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(2), grammarIds: [] }];
    const r = (id: string, kind: Evidence['kind'], skill: Evidence['skill'] = 'recognition'): Evidence => ({ item: { kind: 'word', id }, skill, kind, at: ny(13, 8, 10) });
    let ev = save(ny(13, 8), [], tutor);
    // t0 answered Hard in Review (seen, no Good/Easy marker); t1 never answered (New: not listed)
    ev = [...ev, r('t0', 'review_hard')];
    expect(ledgerAt(ny(13, 9), ev, tutor).faceRatingQueue().map((c) => `${c.item.id}|${c.skill}`)).toEqual(['t0|recognition']);
    // rated Good on the screen: it leaves the queue
    ev = [...ev, r('t0', 'face_rating_good')];
    expect(ledgerAt(ny(13, 9), ev, tutor).faceRatingQueue()).toHaveLength(0);
  });
});

describe('Phase 40 Tests 4: level estimates never change level mastery', () => {
  it('the same learner, with and without estimates on unlevelled words, has the same level numbers', () => {
    const extra = Array.from({ length: 10 }, (_, i) => `x${i}`);
    const plain = new Lexicon([...lesson.vocab, ...tutorIds(30)].map(word).concat(extra.map((id) => ({ ...word(id), level: null }))));
    const est = new Lexicon(
      [...lesson.vocab, ...tutorIds(30)].map(word).concat(extra.map((id) => ({ ...word(id), level: null, estimatedLevel: 'N1' as const, levelSource: 'chars' as const }))),
    );
    const ev: Evidence[] = [...extra, 't0', 't1'].map((id) => ({ item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: ny(1, 8) }));
    const a = ledgerAt(ny(13, 8), ev, [], plain);
    const b = ledgerAt(ny(13, 8), ev, [], est);
    for (const lv of ['N1', 'N2', 'L1'] as const) expect(JSON.stringify(b.level(lv))).toBe(JSON.stringify(a.level(lv)));
  });
});
