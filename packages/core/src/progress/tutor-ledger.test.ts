// Phase 39 Tests 2 (owner, 2026-10-13): tutoring words are added as soon as a class is saved, ahead of
// textbook words and outside the new-word allowance; 20 a session at most; the textbook gets what's left.
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

function ledgerAt(now: Date, evidence: Evidence[], tutorLessons: TutorLesson[]): Ledger {
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
      lexicon,
      books: [book],
      myClass: { enabled: true, textbookId: 'book', currentLesson: 1 },
      settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true },
      tutorLessons,
    },
  });
}

/** What Save does: introduce what the ledger says, now. */
function save(now: Date, evidence: Evidence[], tutorLessons: TutorLesson[]): Evidence[] {
  return [...evidence, ...tutorIntroduceEvidence(ledgerAt(now, evidence, tutorLessons).tutorToIntroduce(), now)];
}

const base = PROGRESS_CONFIG.newPerQueue.review;

describe('Phase 39: tutoring words are added right away', () => {
  it('6 new words: all 6 join this session ahead of textbook words, even with the allowance used up', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(6), grammarIds: [] }];
    const at = ny(13, 8);
    const ev = save(at, [], tutor);
    const ledger = ledgerAt(ny(13, 8, 5), ev, tutor);
    expect(ledger.tutorNewCards().map((c) => c.item.id)).toEqual(tutorIds(6));
    expect(ledger.tutorIntroducedThisSession()).toBe(6);
    // textbook words get only the allowance left (5 − 6 → none this session)
    expect(ledger.newAllowance('review').allowed).toBe(Math.max(0, base - 6));
    expect(ledger.pickNew('review').items.filter((i) => i.id.startsWith('b'))).toHaveLength(0);
    // and the next session's allowance is whole again
    expect(ledgerAt(ny(13, 17), ev, tutor).newAllowance('review').allowed).toBe(base);
  });

  it('2 new words: the textbook gets the 3 left', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(2), grammarIds: [] }];
    const ev = save(ny(13, 8), [], tutor);
    const ledger = ledgerAt(ny(13, 8, 5), ev, tutor);
    expect(ledger.newAllowance('review').allowed).toBe(base - 2);
    const picked = ledger.pickNew('review');
    expect(picked.cards.map((c) => c.item.id).slice(0, 2)).toEqual(tutorIds(2));
    expect(picked.cards.length + picked.items.length).toBe(base - 2);
  });

  it('30 new words: 20 now, the other 10 first thing in the next session', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: tutorIds(30), grammarIds: [] }];
    const ev = save(ny(13, 12), [], tutor); // between sessions
    const now = ledgerAt(ny(13, 12, 5), ev, tutor);
    expect(now.tutorNewCards()).toHaveLength(20);
    expect(now.tutorToIntroduce()).toHaveLength(0); // nothing more this session
    const evening = ledgerAt(ny(13, 16, 1), ev, tutor);
    expect(evening.tutorToIntroduce().map((x) => x.item.id)).toEqual(tutorIds(30).slice(20));
    const after = save(ny(13, 16, 1), ev, tutor);
    expect(ledgerAt(ny(13, 16, 2), after, tutor).tutorNewCards()).toHaveLength(30);
  });

  it('nothing is introduced for a word already carded, Learned or removed', () => {
    const tutor: TutorLesson[] = [{ id: 'tutor-x', date: '2026-10-13T07:00', wordIds: ['b0', 't0'], grammarIds: [] }];
    const known: Evidence = { item: { kind: 'word', id: 'b0' }, skill: 'recognition', kind: 'known_check_passed', at: ny(1, 8) };
    const ledger = ledgerAt(ny(13, 8), [known], tutor);
    expect(ledger.tutorToIntroduce().map((x) => x.item.id)).toEqual(['t0']);
  });
});
