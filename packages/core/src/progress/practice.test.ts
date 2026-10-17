// Phase 45: "Practise these words" any time. Only faces a word already has, never a new word; a
// card's first practice answer of the day counts as a review, later ones that day change nothing but
// Again's priority.
import { describe, expect, it } from 'vitest';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import type { Evidence, ItemRef, Word } from '../types.js';
import { buildLedger, type Ledger } from './ledger.js';
import { practiceAnswerKind, type PracticeGrade } from './practice.js';
import { DEFAULT_SESSION_SETTINGS, sessionKeyAt, zonedDate } from './review-sessions.js';
import { PROGRESS_CONFIG } from './progress.config.js';

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
const WORDS = ['a', 'b', 'c', 'd', 'e'];
const lexicon = new Lexicon(WORDS.map(word));
const items: ItemRef[] = WORDS.map((id) => ({ kind: 'word', id }));
const key = (c: { item: { kind: string; id: string }; skill: string }) => `${c.item.kind}:${c.item.id}|${c.skill}`;
const ev = (id: string, skill: Evidence['skill'], kind: Evidence['kind'], at: Date, context?: Evidence['context']): Evidence => ({
  item: { kind: 'word', id },
  skill,
  kind,
  at,
  ...(context ? { context } : {}),
});
const review = (id: string, skill: Evidence['skill'], kind: Evidence['kind'], at: Date) =>
  ev(id, skill, kind, at, { source: 'review', sessionKey: sessionKeyAt(at, S), face: skill === 'production' ? 'pick' : 'meaning' });

function replay(evidence: readonly Evidence[]): Map<string, SkillCard> {
  const cards = new Map<string, SkillCard>();
  for (const e of [...evidence].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const next = applyEvidence(cards.get(key(e)), e, e.at).card;
    if (next) cards.set(key(e), next);
  }
  return cards;
}

function ledgerAt(now: Date, evidence: Evidence[]): Ledger {
  return buildLedger({
    cards: [...replay(evidence).values()],
    evidence,
    knownItems: [],
    session: S,
    masteryShare: 0.8,
    now,
    study: { lexicon, books: [], settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true } },
  });
}

/** What the practice page does: ask the ledger whether the answer counts, then record it. */
function practise(evidence: Evidence[], id: string, skill: Evidence['skill'], grade: PracticeGrade, at: Date): Evidence[] {
  const counts = ledgerAt(at, evidence).practiceCounts({ item: { kind: 'word', id }, skill });
  const kind = practiceAnswerKind(grade, counts);
  return [...evidence, ev(id, skill, kind, at, { source: 'review', practice: true, sessionKey: sessionKeyAt(at, S), face: skill === 'production' ? 'pick' : 'meaning' })];
}

// a: Meaning and Pick answered; b: Meaning answered, its New Pick card waiting for the face order;
// c: introduced only (New Meaning card); d: answered, then "Never show"; e: no card at all.
const base: Evidence[] = [
  ev('a', 'recognition', 'textbook_lesson_covered', ny(1, 8)),
  review('a', 'recognition', 'review_good', ny(1, 8, 5)),
  review('a', 'recognition', 'review_good', ny(5, 8)),
  ev('a', 'production', 'production_unlocked', ny(5, 8, 1)),
  review('a', 'production', 'review_good', ny(6, 8)),
  ev('b', 'recognition', 'textbook_lesson_covered', ny(1, 8)),
  review('b', 'recognition', 'review_again', ny(9, 8)),
  ev('b', 'production', 'production_unlocked', ny(9, 8, 1)),
  ev('c', 'recognition', 'textbook_lesson_covered', ny(9, 8)),
  ev('d', 'recognition', 'textbook_lesson_covered', ny(1, 8)),
  review('d', 'recognition', 'review_good', ny(1, 8, 5)),
  ev('d', 'recognition', 'review_nope', ny(2, 8), { source: 'review', choice: 'never' }),
];

describe('Phase 45: ledger.practiceCards', () => {
  it('only faces a word already has (answered), never a New card, a removed word or a word with no card', () => {
    const ledger = ledgerAt(ny(10, 20), base);
    const cards = ledger.practiceCards(items);
    expect(cards.map(key).sort()).toEqual(['word:a|production', 'word:a|recognition', 'word:b|recognition']);
    expect(ledger.practiceWordCount(items)).toBe(2);
    expect(ledger.notStartedWords(items)).toEqual(['e']);
  });

  it('in blocks (Meaning before Pick), the weakest first within a block', () => {
    const cards = ledgerAt(ny(10, 20), base).practiceCards(items);
    // b was answered Again (weakest), a twice Good
    expect(cards.map(key)).toEqual(['word:b|recognition', 'word:a|recognition', 'word:a|production']);
  });
});

describe('Phase 45: the first practice answer of the day counts, later ones do not', () => {
  it('first answer moves FSRS and counts one Easy; the second and third that day change nothing', () => {
    const now = ny(10, 20);
    const before = replay(base).get('word:a|recognition')!;
    let evidence = practise(base, 'a', 'recognition', 'easy', now);
    const first = replay(evidence).get('word:a|recognition')!;
    expect(evidence.at(-1)!.kind).toBe('review_easy');
    expect(first.card.due.getTime()).not.toBe(before.card.due.getTime());
    expect(first.flags.easyCount).toBe((before.flags.easyCount ?? 0) + 1);
    evidence = practise(evidence, 'a', 'recognition', 'easy', ny(10, 20, 5));
    evidence = practise(evidence, 'a', 'recognition', 'easy', ny(10, 20, 10));
    expect(evidence.slice(-2).map((e) => e.kind)).toEqual(['practice_easy', 'practice_easy']);
    const after = replay(evidence).get('word:a|recognition')!;
    expect(after.card.due.getTime()).toBe(first.card.due.getTime());
    expect(after.flags.easyCount).toBe(first.flags.easyCount);
    expect(after.flags.goodRun).toBe(first.flags.goodRun);
  });

  it('Easy three times in one day does not make a word Mastered', () => {
    let evidence = base;
    for (const skill of ['recognition', 'production'] as const)
      for (let i = 0; i < 3; i++) evidence = practise(evidence, 'a', skill, 'easy', ny(10, 20, i * 5 + (skill === 'production' ? 1 : 0)));
    const ledger = ledgerAt(ny(10, 21), evidence);
    expect(ledger.mastered({ kind: 'word', id: 'a' })).toBe(false);
    expect(replay(evidence).get('word:a|recognition')!.flags.easyCount).toBe(1);
  });

  it('counts again the next day', () => {
    let evidence = practise(base, 'a', 'recognition', 'good', ny(10, 20));
    evidence = practise(evidence, 'a', 'recognition', 'good', ny(11, 9));
    expect(evidence.slice(-2).map((e) => e.kind)).toEqual(['review_good', 'review_good']);
  });

  it('a card already answered in Review today does not count again in practice', () => {
    const evidence = practise([...base, review('a', 'recognition', 'review_good', ny(10, 8))], 'a', 'recognition', 'easy', ny(10, 20));
    expect(evidence.at(-1)!.kind).toBe('practice_easy');
  });

  it('a practice Again sets priority; the next real review answer clears it', () => {
    let evidence = practise(base, 'a', 'recognition', 'good', ny(10, 20));
    evidence = practise(evidence, 'a', 'recognition', 'again', ny(10, 20, 5));
    expect(evidence.at(-1)!.kind).toBe('practice_again');
    const marked = replay(evidence).get('word:a|recognition')!;
    expect(marked.flags.priority).toBe(true);
    expect(marked.card.due.getTime()).toBe(replay(evidence.slice(0, -1)).get('word:a|recognition')!.card.due.getTime());
    evidence = [...evidence, review('a', 'recognition', 'review_good', ny(20, 8))];
    expect(replay(evidence).get('word:a|recognition')!.flags.priority).toBeUndefined();
  });

  it('practising does not satisfy the 14-day re-check early', () => {
    // three Easy days in Review earn Mastered; five days later a practice Easy counts as a fourth Easy
    let evidence: Evidence[] = [ev('a', 'recognition', 'textbook_lesson_covered', ny(1, 8))];
    for (const d of [2, 3, 4]) evidence.push(review('a', 'recognition', 'review_easy', ny(d, 8)));
    evidence = practise(evidence, 'a', 'recognition', 'easy', ny(9, 20));
    const card = replay(evidence).get('word:a|recognition')!;
    expect(card.flags.rechecked).toBeUndefined();
    expect(card.flags.easyCount).toBeGreaterThanOrEqual(PROGRESS_CONFIG.mastered.easyRatings);
  });
});

describe('Phase 45: practice never changes a session it is not part of', () => {
  it('practising a card not in the session leaves the session unstarted, its cards and done count as they were', () => {
    // morning: b's Meaning is due (answered Again yesterday), a is not due
    const now = ny(10, 8);
    const before = ledgerAt(now, base);
    expect(before.status.session).toBe('morning');
    expect(before.session().cards.map(key)).toContain('word:b|recognition');
    let evidence = practise(base, 'a', 'recognition', 'good', ny(10, 8, 1));
    evidence = practise(evidence, 'a', 'recognition', 'again', ny(10, 8, 2));
    const after = ledgerAt(ny(10, 8, 3), evidence);
    expect(after.session().started).toBe(false);
    expect(after.session().cards.map(key)).toEqual(before.session().cards.map(key));
    expect(after.status.doneThisSession).toBe(before.status.doneThisSession);
    expect(after.newToday()).toEqual(before.newToday());
  });
});
