// Phase 38: the owner's "(unknown item)" review cards. A browser had an old lexicon cached (without
// the Phase 34 extra words) and the new book.json: the study order introduced the extras' ids and
// Review could not show them. The ledger now holds such cards and never picks such a word as new.
import { describe, expect, it } from 'vitest';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import { pickNewForSession } from '../study/queue.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Evidence, ItemRef, Word } from '../types.js';
import { buildLedger } from './ledger.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate } from './review-sessions.js';

const TZ = 'America/New_York';
const now = zonedDate(2026, 10, 13, 8, 0, TZ);
const DAY = 86_400_000;
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
const lesson: Lesson = {
  id: 'laixue-1-L01',
  n: 1,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: ['core-a', 'core-b'],
  supplementary: [],
  extra: ['extra-a', 'extra-b'],
  properNouns: [],
  grammar: [],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
};
const book: Textbook = { id: 'laixue-1', titleZh: '', titleEn: '', lessons: [lesson] };
const NEW_LEXICON = new Lexicon(['core-a', 'core-b', 'extra-a', 'extra-b'].map(word));
const OLD_LEXICON = new Lexicon(['core-a', 'core-b'].map(word)); // cached before Phase 34

const ref = (id: string): ItemRef => ({ kind: 'word', id });
function cardsFrom(events: Evidence[]): SkillCard[] {
  const out = new Map<string, SkillCard>();
  for (const ev of events) {
    const key = `${ev.item.id}|${ev.skill}`;
    const next = applyEvidence(out.get(key), ev, ev.at).card;
    if (next) out.set(key, next);
  }
  return [...out.values()];
}
// both core words known; one extra already answered two days ago (now due)
const events: Evidence[] = [
  { item: ref('core-a'), skill: 'recognition', kind: 'known_check_passed', at: new Date(now.getTime() - 30 * DAY) },
  { item: ref('core-b'), skill: 'recognition', kind: 'known_check_passed', at: new Date(now.getTime() - 30 * DAY) },
  { item: ref('extra-a'), skill: 'recognition', kind: 'review_again', at: new Date(now.getTime() - 2 * DAY) },
];
const ledgerWith = (lexicon: Lexicon) =>
  buildLedger({
    cards: cardsFrom(events),
    evidence: events,
    knownItems: [],
    session: { ...DEFAULT_SESSION_SETTINGS, timeZone: TZ },
    masteryShare: 0.8,
    now,
    study: { lexicon, books: [book], settings: { ...DEFAULT_STUDY_SETTINGS, enabled: true } },
  });

describe('Phase 38: no "(unknown item)" cards', () => {
  it('with the new lexicon the extras are normal cards and new words', () => {
    const ledger = ledgerWith(NEW_LEXICON);
    expect(ledger.unresolved()).toEqual([]);
    expect(ledger.session().words).toContain('extra-a');
    expect(ledger.focus()!.newItemsAllowed.map((i) => i.id)).toContain('extra-b');
    expect(ledger.pickNew('review').items.map((i) => i.id)).toContain('extra-b');
  });

  it('with only the old lexicon cached, no extra is introduced and the answered one is held', () => {
    const ledger = ledgerWith(OLD_LEXICON);
    expect(ledger.unresolved().map((c) => c.item.id)).toEqual(['extra-a']);
    expect(ledger.session().words).not.toContain('extra-a');
    expect(ledger.status.sessionCards).toBe(0);
    expect(ledger.focus()!.newItemsAllowed.map((i) => i.id)).not.toContain('extra-b');
    const picked = ledger.pickNew('review', { extraItems: [ref('extra-b')] });
    expect([...picked.items, ...picked.cards.map((c) => c.item)].map((i) => i.id)).toEqual([]);
  });

  it('pickNewForSession skips ids the word list cannot resolve', () => {
    const picked = pickNewForSession({
      newCards: [],
      allowed: 5,
      extraItems: [ref('core-a'), ref('gone')],
      resolves: (i) => i.id !== 'gone',
    });
    expect(picked.items.map((i) => i.id)).toEqual(['core-a']);
  });
});
