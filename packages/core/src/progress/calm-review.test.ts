// Phase 43 (owner, 2026-10-16: "having 100 cards to review is just so discouraging"): the owner's
// backlog, and the property that no day ever starts more than its limits, whatever the learner does.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Rating } from 'ts-fsrs';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import { tutorIntroduceEvidence, type TutorLesson } from '../tutor/session.js';
import type { Evidence, Word } from '../types.js';
import { buildLedger, type Ledger } from './ledger.js';
import { goodRunsFromHistory, type RunAnswer } from './good-run.js';
import { PROGRESS_CONFIG } from './progress.config.js';
import { DEFAULT_SESSION_SETTINGS, sessionKeyAt, zonedDate } from './review-sessions.js';

const TZ = 'America/New_York';
const S = { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ };
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
const key = (c: { item: { kind: string; id: string }; skill: string }) => `${c.item.kind}:${c.item.id}|${c.skill}`;
const r = (id: string, skill: Evidence['skill'], kind: Evidence['kind'], at: Date): Evidence => ({ item: { kind: 'word', id }, skill, kind, at });

function cardsOf(evidence: readonly Evidence[], patch?: (cards: Map<string, SkillCard>) => void): SkillCard[] {
  const cards = new Map<string, SkillCard>();
  for (const ev of [...evidence].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const next = applyEvidence(cards.get(key(ev)), ev, ev.at).card;
    if (next) cards.set(key(ev), next);
  }
  patch?.(cards);
  return [...cards.values()];
}

function ledgerOf(now: Date, evidence: Evidence[], tutorLessons: TutorLesson[], lexicon: Lexicon, cards?: SkillCard[]): Ledger {
  return buildLedger({
    cards: cards ?? cardsOf(evidence),
    evidence,
    knownItems: [],
    session: S,
    masteryShare: 0.8,
    now,
    study: { lexicon, books: [], settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true }, tutorLessons },
  });
}

describe("Phase 43 Tests 1: the owner's backlog", () => {
  // 50 tutoring words saved on the 14th with every face (Phase 40), 30 rated Good once on Meaning
  // (Phase 42 released Pick at once) and 15 of those Picks answered; 60 older cards due; then the
  // 15th's morning and evening were skipped. Before Phase 43 that was 152 cards in one session.
  const tutorWords = Array.from({ length: 50 }, (_, i) => `t${i}`);
  const oldWords = Array.from({ length: 60 }, (_, i) => `o${i}`);
  const lexicon = new Lexicon([...tutorWords, ...oldWords].map(word));
  const tutor: TutorLesson[] = [{ id: 'class-1', date: '2026-10-14T07:00', wordIds: tutorWords, grammarIds: [] }];
  const evidence: Evidence[] = [
    ...oldWords.map((id) => r(id, 'recognition', 'review_good', ny(9, 8))),
    ...tutorWords.flatMap((id) => [
      r(id, 'recognition', 'textbook_lesson_covered', ny(14, 7)),
      r(id, 'production', 'production_unlocked', ny(14, 7)),
      r(id, 'reading', 'reading_unlocked', ny(14, 7)),
    ]),
    ...tutorWords.slice(0, 30).map((id) => r(id, 'recognition', 'review_good', ny(14, 8, 10))),
    ...tutorWords.slice(0, 15).map((id) => ({ ...r(id, 'production', 'review_good', ny(14, 8, 20)), context: { source: 'review' as const, face: 'pick' as const } })),
  ];
  const now = ny(16, 8);

  it('after the migration the morning session holds at most 40 cards, no unanswered later faces, at most 8 new words, and loses nothing', () => {
    const answers: RunAnswer[] = evidence
      .filter((e) => e.kind.startsWith('review_'))
      .map((e) => ({ key: key(e), at: e.at, grade: e.kind === 'review_good' ? Rating.Good : Rating.Again }));
    const runs = goodRunsFromHistory(answers, S);
    const before = cardsOf(evidence);
    const cards = before.map((c) => ({ ...c, flags: { ...c.flags, ...(runs.get(key(c)) ?? {}) } }));
    const ledger = ledgerOf(now, evidence, tutor, lexicon, cards);
    const session = ledger.session();
    expect(session.cards.length).toBeLessThanOrEqual(40);
    expect(ledger.status.sessionCards).toBeLessThanOrEqual(40);
    // never-answered Pick / Say it cards are held (a Meaning rated Good once releases nothing)
    expect(session.cards.filter((c) => c.skill !== 'recognition' && c.card.reps === 0)).toHaveLength(0);
    const newWords = session.fresh.filter((c) => c.skill === 'recognition');
    expect(newWords.length).toBeLessThanOrEqual(Math.ceil(PROGRESS_CONFIG.newPerDay.words / 2));
    // the rest wait and are said to wait
    expect(ledger.status.waiting).toBeGreaterThan(0);
    // nothing answered is lost: every card is still there, with the same answers and due date
    const after = new Map(ledger.cards.map((c) => [key(c), c]));
    for (const c of before) {
      expect(after.get(key(c))?.card.reps).toBe(c.card.reps);
      expect(after.get(key(c))?.card.due.getTime()).toBe(c.card.due.getTime());
    }
  });
});

describe('Phase 43 Part A property: no day ever starts more than its limits', () => {
  it('whatever sessions are done or skipped and however cards are rated', () => {
    const tutorWords = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const lexicon = new Lexicon(tutorWords.map(word));
    const tutor: TutorLesson[] = [{ id: 'class-1', date: '2026-10-12T07:00', wordIds: tutorWords, grammarIds: [] }];
    const visits = [ny(13, 8), ny(13, 17), ny(14, 8), ny(14, 17), ny(15, 8), ny(15, 17), ny(16, 8), ny(16, 17)];
    const grades: Evidence['kind'][] = ['review_again', 'review_hard', 'review_good', 'review_easy'];
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: visits.length, maxLength: visits.length }),
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 200, maxLength: 200 }),
        (done, picks) => {
          let ev: Evidence[] = [];
          let g = 0;
          const firstByDay = new Map<string, { words: number; faces: number }>();
          for (const [i, at] of visits.entries()) {
            // Save / Review make the cards the ledger asks for (Meaning, then released faces)
            ev = [...ev, ...tutorIntroduceEvidence(ledgerOf(at, ev, tutor, lexicon).tutorToIntroduce(), at)];
            if (!done[i]) continue;
            const ledger = ledgerOf(at, ev, tutor, lexicon);
            const day = sessionKeyAt(at, S).slice(0, 10);
            const tally = firstByDay.get(day) ?? { words: 0, faces: 0 };
            for (const c of ledger.session().cards) {
              if (c.card.reps === 0 && c.skill === 'recognition') tally.words++;
              else if (c.card.reps === 0) tally.faces++;
              const kind = grades[picks[g++ % picks.length]!]!;
              ev.push({ ...r(c.item.id, c.skill, kind, new Date(at.getTime() + 60_000)), context: { source: 'review', sessionKey: sessionKeyAt(at, S) } });
            }
            firstByDay.set(day, tally);
          }
          for (const t of firstByDay.values()) {
            expect(t.words).toBeLessThanOrEqual(PROGRESS_CONFIG.newPerDay.words);
            expect(t.faces).toBeLessThanOrEqual(PROGRESS_CONFIG.newPerDay.faces);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
