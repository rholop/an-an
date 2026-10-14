// Phase 39 Tests 2 / Phase 40 Tests 7 (owner, 2026-10-14): a saved class's words are in review at once,
// at any time of day, outside the new-word allowance and the session cap. Phase 42: at most
// `newWordsPerDay` words start a day, and a word's faces follow Meaning → Pick → Say it, each released
// by a Good or Easy on the face before.
import { describe, expect, it } from 'vitest';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import { TUTOR_CONFIG } from '../tutor/tutor.config.js';
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

const base = PROGRESS_CONFIG.newPerQueue.review;

describe('Phase 40: tutoring words are in review the moment a class is saved', () => {
  it('6 new words: their Meaning cards are in this session, and the textbook keeps its whole allowance', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(6), grammarIds: [] }];
    const ev = save(ny(13, 8), [], tutor);
    const ledger = ledgerAt(ny(13, 8, 5), ev, tutor);
    expect(ledger.tutorNewCards().map((c) => c.item.id)).toEqual(tutorIds(6));
    expect(ledger.tutorIntroducedThisSession()).toBe(6);
    const inSession = ledger.session().cards.filter((c) => c.item.id.startsWith('t'));
    expect(inSession).toHaveLength(6);
    expect(inSession.every((c) => c.skill === 'recognition')).toBe(true);
    // tutoring words never use up the textbook's new words
    expect(ledger.newAllowance('review').allowed).toBe(base);
    const picked = ledger.pickNew('review');
    expect(picked.cards.length + picked.items.length).toBe(base);
    expect([...picked.cards.map((c) => c.item.id), ...picked.items.map((x) => x.id)].some((id) => tutorIds(6).includes(id))).toBe(false);
  });

  it('a 30-word class saved at 13:00 (between sessions): 25 Meaning cards are in review now, oldest first', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    const ev = save(ny(13, 13), [], tutor);
    const ledger = ledgerAt(ny(13, 13, 1), ev, tutor);
    expect(ledger.tutorToIntroduce()).toHaveLength(0); // every word has its Meaning card from Save
    const cards = ledger.session().cards;
    const max = TUTOR_CONFIG.newWordsPerDay;
    expect(cards).toHaveLength(max);
    expect(cards.every((c) => c.skill === 'recognition')).toBe(true);
    expect(cards.map((c) => c.item.id).sort()).toEqual(tutorIds(max).sort());
    expect(ledger.status.reviewAll).toBe(max);
  });

  it('a word\'s Pick card waits for a Good or Easy on Meaning; Again and Hard do not release it', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(4), grammarIds: [] }];
    const rate = (id: string, kind: Evidence['kind']): Evidence => ({ item: { kind: 'word', id }, skill: 'recognition', kind, at: ny(13, 8, 10) });
    let ev = save(ny(13, 8), [], tutor);
    ev = [...ev, rate('t0', 'review_again'), rate('t1', 'review_hard'), rate('t2', 'review_good'), rate('t3', 'review_easy')];
    ev = save(ny(13, 8, 20), ev, tutor);
    const ledger = ledgerAt(ny(13, 8, 21), ev, tutor);
    const pick = ledger.session().cards.filter((c) => c.skill === 'production' && c.state !== 'unseen' && c.card.reps === 0);
    expect(pick.map((c) => c.item.id).sort()).toEqual(['t2', 't3']);
    // no Say it card yet: Pick has not been rated
    expect(ledger.session().cards.some((c) => c.skill === 'reading')).toBe(false);
  });

  it('a Say it card waits for a Good or Easy on Pick', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(2), grammarIds: [] }];
    const r = (id: string, skill: Evidence['skill'], kind: Evidence['kind'], m: number): Evidence => ({ item: { kind: 'word', id }, skill, kind, at: ny(13, 8, m) });
    let ev = save(ny(13, 8), [], tutor);
    ev = [...ev, r('t0', 'recognition', 'review_good', 10), r('t1', 'recognition', 'review_good', 10)];
    ev = save(ny(13, 8, 15), ev, tutor);
    ev = [...ev, r('t0', 'production', 'review_good', 20), r('t1', 'production', 'review_again', 20)];
    ev = save(ny(13, 8, 25), ev, tutor);
    const ledger = ledgerAt(ny(13, 8, 26), ev, tutor);
    const say = ledger.session({}).cards.filter((c) => c.skill === 'reading').map((c) => c.item.id);
    expect(say).toEqual(['t0']);
  });

  it('only 25 words start a day: after starting 25, the rest wait until tomorrow', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    const ids = tutorIds(25);
    const ev = [
      ...save(ny(13, 8), [], tutor),
      ...ids.map((id): Evidence => ({ item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: ny(13, 8, 10) })),
    ];
    const today = ledgerAt(ny(13, 8, 30), ev, tutor).session().cards.filter((c) => c.skill === 'recognition' && c.card.reps === 0);
    expect(today).toHaveLength(0);
    // next morning the budget is back: the other 5 words start
    const tomorrow = ledgerAt(ny(14, 8, 0), ev, tutor).session().cards.filter((c) => c.skill === 'recognition' && c.card.reps === 0);
    expect(tomorrow.map((c) => c.item.id).sort()).toEqual(tutorIds(30).slice(25).sort());
  });

  it('the session cap never pushes tutoring cards out: other cards are dropped first', () => {
    const others = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const lex = new Lexicon([...lesson.vocab, ...tutorIds(30), ...others].map(word));
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    const old: Evidence[] = others.map((id) => ({ item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: ny(1, 8) }));
    const ev = save(ny(13, 8), old, tutor, lex);
    const ledger = ledgerAt(ny(13, 8, 1), ev, tutor, lex);
    const cap = DEFAULT_SESSION_SETTINGS.capPerSession;
    // every tutoring Meaning card of the day is in, and the other cards fill only the cap
    expect(ledger.status.reviewAll).toBe(TUTOR_CONFIG.newWordsPerDay + cap);
  });

  it('nothing is introduced for a word already carded, Learned or removed', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: ['b0', 't0'], grammarIds: [] }];
    const known: Evidence = { item: { kind: 'word', id: 'b0' }, skill: 'recognition', kind: 'known_check_passed', at: ny(1, 8) };
    const ledger = ledgerAt(ny(13, 8), [known], tutor);
    expect(ledger.tutorToIntroduce().map((x) => x.item.id)).toEqual(['t0']);
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
