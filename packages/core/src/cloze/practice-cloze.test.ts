// Phase 47 (owner, 2026-10-18): Cloze always has word clozes (practice outside the review session,
// counted as Phase 45 does), and a journal fix waits until every word of its answer is known.
import { describe, expect, it } from 'vitest';
import { emptyCard } from '../learner/fsrs-instance.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import type { ErrorItem } from '../journal/types.js';
import { unknownAnswerWords } from '../journal/answer-words.js';
import type { Evidence, Word } from '../types.js';
import { buildLedger, type Ledger } from '../progress/ledger.js';
import { DEFAULT_SESSION_SETTINGS, sessionKeyAt, zonedDate } from '../progress/review-sessions.js';
import { buildMixedSession, clozePracticeEvidence } from './session.js';

const TZ = 'America/New_York';
const S = { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ };
const ny = (day: number, h: number, m = 0) => zonedDate(2026, 10, day, h, m, TZ);
const HW = ['我', '你', '他', '她', '貓', '狗', '魚', '鳥', '馬', '牛', '羊', '茶', '水餃', '想', '吃'];
const word = (hw: string, i: number): Word => ({
  id: `w${i}`,
  headword: hw,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: hw,
  chars: [...hw],
  tags: [],
});
const WORDS = HW.map(word);
const lexicon = new Lexicon(WORDS);
const id = (hw: string) => WORDS.find((w) => w.headword === hw)!.id;
const key = (c: { item: { kind: string; id: string }; skill: string }) => `${c.item.kind}:${c.item.id}|${c.skill}`;
const ev = (hw: string, kind: Evidence['kind'], at: Date, context?: Evidence['context']): Evidence => ({
  item: { kind: 'word', id: id(hw) },
  skill: 'recognition',
  kind,
  at,
  ...(context ? { context } : {}),
});
const reviewed = (hw: string): Evidence[] => [
  ev(hw, 'textbook_lesson_covered', ny(1, 8)),
  ev(hw, 'review_good', ny(1, 8, 5), { source: 'review', sessionKey: sessionKeyAt(ny(1, 8, 5), S), face: 'meaning' }),
  ev(hw, 'review_good', ny(5, 8), { source: 'review', sessionKey: sessionKeyAt(ny(5, 8), S), face: 'meaning' }),
];

function replay(evidence: readonly Evidence[]): SkillCard[] {
  const cards = new Map<string, SkillCard>();
  for (const e of [...evidence].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const next = applyEvidence(cards.get(key(e)), e, e.at).card;
    if (next) cards.set(key(e), next);
  }
  return [...cards.values()];
}
const ledgerAt = (now: Date, evidence: Evidence[]): Ledger =>
  buildLedger({
    cards: replay(evidence),
    evidence,
    knownItems: [],
    session: S,
    masteryShare: 0.8,
    now,
    study: { lexicon, books: [], settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true } },
  });

// "I want to eat [dumplings]" → 我想吃水餃 (the learner wrote English; the answer is 水餃)
const gap = (over: Partial<ErrorItem> = {}): ErrorItem => ({
  id: 'j1:0',
  journalEntryId: 'j1',
  original: '我想吃dumplings。',
  corrected: '我想吃水餃。',
  span: [3, 12],
  blank: [3, 5],
  type: 'error',
  card: emptyCard(ny(1, 8)),
  flagged: false,
  createdAt: ny(1, 8),
  version: 2,
  status: 'active',
  ...over,
});

// 12 words answered on days 1 and 5; at noon on day 6 (between sessions) nothing is in a session.
const LEARNED = ['我', '你', '他', '她', '貓', '狗', '魚', '鳥', '馬', '牛', '想', '吃'];
const base = LEARNED.flatMap(reviewed);
const NOON = ny(6, 12);

describe('Phase 47 Part B: a journal fix waits for the words of its answer', () => {
  it('names the unknown words of the answer, and none once they are known', () => {
    expect(unknownAnswerWords(gap(), { lexicon, ids: new Set() })).toEqual([id('水餃')]);
    expect(unknownAnswerWords(gap(), { lexicon, ids: new Set([id('水餃')]) })).toEqual([]);
    // a deletion has no answer words
    expect(unknownAnswerWords(gap({ corrected: '我想吃。', blank: [3, 3] }), { lexicon, ids: new Set() })).toEqual([]);
  });

  it('水餃 not learned: the fix waits (counted, never shown); learned: it is shown', () => {
    const before = ledgerAt(NOON, base).errorItems([gap()]);
    expect(before.due).toEqual([]);
    expect(before.waiting.map((w) => [w.item.id, w.wordIds])).toEqual([['j1:0', [id('水餃')]]]);
    const after = ledgerAt(NOON, [...base, ...reviewed('水餃')]).errorItems([gap()]);
    expect(after.due.map((i) => i.id)).toEqual(['j1:0']);
    expect(after.waiting).toEqual([]);
  });

  it('no error item in a built session has an answer word outside comprehensible', () => {
    const ledger = ledgerAt(NOON, base);
    const { due, known } = ledger.errorItems([gap(), gap({ id: 'j2:0', corrected: '我想吃魚。', blank: [3, 4] })]);
    const session = buildMixedSession(ledger.clozePracticeCards(), {
      lexicon,
      knownIds: ledger.comprehensible().ids,
      learnerLevel: 'L1',
      errorItems: due,
      now: NOON,
      seed: 'p47',
      keepOrder: true,
      ...(known ? { known } : {}),
    });
    const errors = session.flatMap((e) => (e.kind === 'error' ? [e.error] : []));
    expect(errors.map((e) => e.id)).toEqual(['j2:0']);
    for (const e of errors) expect(unknownAnswerWords(e, known!)).toEqual([]);
  });
});

describe('Phase 47 Part A: Cloze practice outside the review session', () => {
  it('after the session is done: practice is every answered word, mostly word clozes, fixes ≤ 3 and never adjacent', () => {
    const ledger = ledgerAt(NOON, base);
    expect(ledger.session().cards).toEqual([]);
    expect(ledger.clozePracticeWordCount()).toBe(LEARNED.length);
    const fixes = Array.from({ length: 6 }, (_, i) => gap({ id: `f${i}:0`, corrected: '我想吃魚。', blank: [3, 4] }));
    const { due, known } = ledger.errorItems(fixes);
    const session = buildMixedSession(ledger.clozePracticeCards(), {
      lexicon,
      knownIds: ledger.comprehensible().ids,
      learnerLevel: 'L1',
      errorItems: due,
      now: NOON,
      seed: 'p47',
      keepOrder: true,
      ...(known ? { known } : {}),
    });
    const kinds = session.map((e) => e.kind);
    expect(kinds[0]).toBe('card');
    expect(kinds.filter((k) => k === 'card').length).toBeGreaterThan(kinds.length / 2);
    expect(kinds.filter((k) => k === 'error').length).toBeLessThanOrEqual(3);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i] === 'error' && kinds[i - 1] === 'error').toBe(false);
  });

  it('never a New card or a new word: practice only holds answered cards', () => {
    const ledger = ledgerAt(NOON, [...base, ev('茶', 'textbook_lesson_covered', ny(6, 9))]);
    expect(ledger.clozePracticeCards().some((c) => c.item.id === id('茶'))).toBe(false);
    const before = ledger.newToday();
    const at = ny(6, 12, 5);
    const card = ledger.clozePracticeCards()[0]!;
    const after = ledgerAt(at, [...base, ev('茶', 'textbook_lesson_covered', ny(6, 9)), ...clozePracticeEvidence({ card }, 'cloze_correct_nohint', at, (c) => ledger.practiceCounts(c))]);
    expect(after.newToday()).toEqual(before);
  });

  it("a card's first cloze answer of the day moves FSRS (and the ladder); a second one doesn't", () => {
    const l0 = ledgerAt(NOON, base);
    const card = l0.clozePracticeCards().find((c) => c.item.id === id('貓'))!;
    const first = clozePracticeEvidence({ card }, 'cloze_correct_nohint', ny(6, 12, 1), (c) => l0.practiceCounts(c));
    expect(first.map((e) => [e.kind, e.context?.practice])).toEqual([['review_good', true]]);
    const after1 = [...base, ...first];
    const c1 = replay(after1).find((c) => key(c) === key(card))!;
    expect(c1.card.due.getTime()).toBeGreaterThan(card.card.due.getTime());
    expect(c1.clozeStreak).toBe(1);

    const l1 = ledgerAt(ny(6, 12, 2), after1);
    const second = clozePracticeEvidence({ card: c1 }, 'cloze_wrong', ny(6, 12, 2), (c) => l1.practiceCounts(c));
    expect(second.map((e) => e.kind)).toEqual(['practice_again']);
    const c2 = replay([...after1, ...second]).find((c) => key(c) === key(card))!;
    expect(c2.card).toEqual(c1.card);
    expect(c2.flags.priority).toBe(true);
  });

  it('a session cloze answer today means a practice answer of the same card does not count', () => {
    const at = ny(6, 12, 1);
    const l = ledgerAt(at, [...base, ev('貓', 'cloze_correct_nohint', ny(6, 11))]);
    expect(l.practiceCounts({ item: { kind: 'word', id: id('貓') }, skill: 'recognition' })).toBe(false);
  });

  it('"Add to review" from a waiting fix: the word takes the next new-word slot', () => {
    // two new words introduced earlier; 水餃 added from a waiting fix comes first in the evening session
    const ev0 = [...base, ev('茶', 'textbook_lesson_covered', ny(4, 9)), ev('羊', 'textbook_lesson_covered', ny(4, 9))];
    const added = [...ev0, ev('水餃', 'review_restore', ny(6, 13), { source: 'cloze', priority: true })];
    const l = ledgerAt(ny(6, 18), added);
    const fresh = l.session().cards.filter((c) => c.state === 'introduced').map((c) => c.item.id);
    expect(fresh[0]).toBe(id('水餃'));
  });
});
