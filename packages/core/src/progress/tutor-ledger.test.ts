// Phase 39 Tests 2 / Phase 40 Tests 7 (owner, 2026-10-14): a saved class's words are in review at once,
// every face, at any time of day, outside the new-word allowance and the session cap.
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

const base = PROGRESS_CONFIG.newPerQueue.review;
const FACES = ['recognition', 'production', 'reading'] as const;

describe('Phase 40: tutoring words are in review the moment a class is saved', () => {
  it('6 new words: every face of all 6 is in this session, and the textbook keeps its whole allowance', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(6), grammarIds: [] }];
    const ev = save(ny(13, 8), [], tutor);
    const ledger = ledgerAt(ny(13, 8, 5), ev, tutor);
    expect(ledger.tutorNewCards().map((c) => c.item.id)).toEqual(tutorIds(6));
    expect(ledger.tutorIntroducedThisSession()).toBe(6);
    const inSession = ledger.session().cards.filter((c) => c.item.id.startsWith('t'));
    expect(inSession).toHaveLength(6 * FACES.length);
    // tutoring words never use up the textbook's new words
    expect(ledger.newAllowance('review').allowed).toBe(base);
    const picked = ledger.pickNew('review');
    expect(picked.cards.length + picked.items.length).toBe(base);
    expect([...picked.cards.map((c) => c.item.id), ...picked.items.map((x) => x.id)].some((id) => tutorIds(6).includes(id))).toBe(false);
  });

  it('a 30-word class saved at 13:00 (between sessions): every face of every word is in review now', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    const ev = save(ny(13, 13), [], tutor);
    const ledger = ledgerAt(ny(13, 13, 1), ev, tutor);
    expect(ledger.tutorToIntroduce()).toHaveLength(0); // no limit: everything joined at Save
    const cards = ledger.session().cards;
    expect(cards).toHaveLength(30 * FACES.length);
    for (const id of tutorIds(30)) for (const f of FACES) expect(cards.some((c) => c.item.id === id && c.skill === f)).toBe(true);
    expect(ledger.status.reviewAll).toBe(30 * FACES.length);
    expect(ledger.tutorClassNow('tutor-x')).toHaveLength(30 * FACES.length);
  });

  it('the session cap never pushes tutoring cards out: other cards are dropped first', () => {
    const others = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const lex = new Lexicon([...lesson.vocab, ...tutorIds(30), ...others].map(word));
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    const old: Evidence[] = others.map((id) => ({ item: { kind: 'word', id }, skill: 'recognition', kind: 'review_good', at: ny(1, 8) }));
    const ev = save(ny(13, 8), old, tutor, lex);
    const ledger = ledgerAt(ny(13, 8, 1), ev, tutor, lex);
    const cap = DEFAULT_SESSION_SETTINGS.capPerSession;
    // every tutoring card is in, and the other cards fill only the cap
    expect(ledger.status.reviewAll).toBe(30 * FACES.length + cap);
  });

  it('nothing is introduced for a word already carded, Learned or removed', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: ['b0', 't0'], grammarIds: [] }];
    const known: Evidence = { item: { kind: 'word', id: 'b0' }, skill: 'recognition', kind: 'known_check_passed', at: ny(1, 8) };
    const ledger = ledgerAt(ny(13, 8), [known], tutor);
    expect(ledger.tutorToIntroduce().map((x) => x.item.id)).toEqual(['t0']);
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
