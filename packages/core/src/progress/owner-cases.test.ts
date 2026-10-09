// Phase 29 Part C.5: the owner's three reports, as named regression tests. Each one was two screens
// counting the same thing their own way; with the ledger they are one number.
import { describe, expect, it } from 'vitest';
import { applyEvidence } from '../learner/apply-evidence.js';
import { buildFsrs } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type SkillCard } from '../learner/types.js';
import { Lexicon } from '../lexicon.js';
import { buildPlants } from '../game/garden.js';
import { DEFAULT_STUDY_SETTINGS } from '../study/study-focus.js';
import { lessonTag, textbookTag } from '../textbook/scope.js';
import type { Lesson, Textbook } from '../textbook/types.js';
import type { Evidence, ItemRef, Word } from '../types.js';
import { buildLedger } from './ledger.js';
import { DEFAULT_SESSION_SETTINGS, zonedDate } from './review-sessions.js';

const TZ = 'America/New_York';
const ny = (day: number, h: number, m = 0) => zonedDate(2026, 10, day, h, m, TZ);
const fsrs = buildFsrs(DEFAULT_LEARNER_CONFIG);

const lesson = (n: number): Lesson => ({
  id: `laixue-1-L0${n}`,
  n,
  titleZh: '',
  titleEn: '',
  topic: '',
  objectives: [],
  vocab: [`l${n}-a`, `l${n}-b`, `l${n}-c`, `name${n}`],
  supplementary: [],
  properNouns: [`name${n}`],
  grammar: [`g${n}`],
  dialogueRef: '',
  scenarios: [],
  journalPrompts: [],
});
const book: Textbook = { id: 'laixue-1', titleZh: '', titleEn: '', lessons: [lesson(1), lesson(2)] };
const word = (id: string, n?: number): Word => ({
  id,
  headword: id,
  variants: [],
  pos: ['N'],
  level: 'N1',
  source: id.startsWith('name') ? 'textbook' : 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: id,
  chars: [id],
  tags: n ? [textbookTag('laixue-1'), lessonTag(n, 'laixue-1')] : [],
});
const lexicon = new Lexicon([
  ...book.lessons.flatMap((l) => l.vocab.map((id) => word(id, l.n))),
  ...Array.from({ length: 12 }, (_, i) => word(`w${i}`)),
]);

const wordRef = (id: string): ItemRef => ({ kind: 'word', id });

/** Replays answers through the scheduler, like the app does, and returns the cards and the log. */
function replay(events: Evidence[]): { cards: SkillCard[]; evidence: Evidence[] } {
  const cards = new Map<string, SkillCard>();
  for (const ev of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const key = `${ev.item.kind}:${ev.item.id}|${ev.skill}`;
    const next = applyEvidence(cards.get(key), ev, ev.at).card;
    if (next) cards.set(key, next);
  }
  return { cards: [...cards.values()], evidence: events };
}
const answer = (id: string, kind: Evidence['kind'], at: Date, skill: Evidence['skill'] = 'recognition', context?: Evidence['context']): Evidence => ({
  item: wordRef(id),
  skill,
  kind,
  at,
  ...(context ? { context } : {}),
});

describe("the owner's reports (Phase 29 Part C.5)", () => {
  it('"Home says 3, Review shows 0" (Phase 22)', () => {
    // three words answered yesterday morning that fall due at 09:30 today: inside this morning's
    // session, but not yet "due now" at 08:00. Home counted the session, Review the exact due time.
    const { cards, evidence } = replay(['w0', 'w1', 'w2'].map((id) => answer(id, 'review_good', ny(8, 8))));
    const moved = cards.map((c) => ({ ...c, card: { ...c.card, due: ny(9, 9, 30) } }));
    const ledger = buildLedger({ cards: moved, evidence, knownItems: [], session: DEFAULT_SESSION_SETTINGS, masteryShare: 0.8, now: ny(9, 8) });
    expect(ledger.status.session).toBe('morning');
    // Home ("Review all (3)"), the nav badge and the Review screen all read the same session
    expect(ledger.status.dueNow).toBe(3);
    expect(ledger.status.reviewAll).toBe(3);
    expect(ledger.session().cards).toHaveLength(3);
  });

  it('"lesson 100% but Now studying 17%" (Phase 21)', () => {
    // Lesson 1 is mastered three different ways: answers (l1-a), "I already know this" (l1-b),
    // a legacy known item (g1), and one word removed by Nope (l1-c). The chip said 100% while Now
    // studying counted it over a different item set.
    const { cards, evidence } = replay([
      ...['l1-a', 'l2-a'].flatMap((id) => [
        answer(id, 'known_check_passed', ny(1, 8)),
        answer(id, 'known_check_passed', ny(1, 8), 'production'),
      ]),
      answer('l1-b', 'known_check_passed', ny(2, 8)),
      answer('l1-b', 'known_check_passed', ny(2, 8), 'production'),
      answer('l1-c', 'review_good', ny(2, 8)),
      answer('l1-c', 'review_nope', ny(3, 8), 'recognition', { source: 'review', choice: 'never' }),
    ]);
    const knownItems = ['grammar:g1'];
    const share = 0.8;
    const ledger = buildLedger({
      cards,
      evidence,
      knownItems,
      session: DEFAULT_SESSION_SETTINGS,
      masteryShare: share,
      now: ny(9, 12),
      study: { lexicon, books: [book], settings: { ...DEFAULT_STUDY_SETTINGS, masteryShare: share, knownItems } },
    });
    const l1 = ledger.lesson(book.lessons[0]!);
    expect(l1.masteredShare).toBe(1);
    expect(l1.done).toBe(true);
    expect(l1.stillToMaster).toEqual([]);
    const focus = ledger.focus()!;
    expect(focus.masteredLessonIds).toContain(book.lessons[0]!.id);
    // Now studying moved on to lesson 2, with the lesson page's own numbers
    expect(focus.activeLesson?.lessonId).toBe(book.lessons[1]!.id);
    const l2 = ledger.lesson(book.lessons[1]!);
    expect(focus.mastery?.masteredShare).toBe(l2.masteredShare);
    expect(focus.mastery?.learnedShare).toBe(l2.learnedShare);
    expect(l2.done).toBe(false);
    expect(l2.stillToMaster.length).toBeGreaterThan(0);
  });

  it('"10 to water after morning review and lesson study" (Phase 27)', () => {
    // Ten words due this morning. Six are answered in Review, four in the lesson's Vocab step (two
    // of those with an Again first, finished in the same sitting). Afterwards nothing needs water.
    const ids = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const learnt = replay(ids.map((id) => answer(id, 'review_good', ny(7, 8))));
    const dueNow = learnt.cards.map((c) => ({ ...c, card: { ...c.card, due: ny(9, 7) } }));
    const before = buildLedger({ cards: dueNow, evidence: learnt.evidence, knownItems: [], session: DEFAULT_SESSION_SETTINGS, masteryShare: 0.8, now: ny(9, 8) });
    expect(before.thirstyWords()).toHaveLength(10);

    const sitting: Evidence[] = [
      ...ids.slice(0, 6).map((id, i) => answer(id, 'review_good', ny(9, 8, i), 'recognition', { source: 'review' })),
      ...ids.slice(6).flatMap((id, i) =>
        i < 2
          ? [
              answer(id, 'review_again', ny(9, 8, 10 + i), 'recognition', { source: 'textbook' }),
              answer(id, 'review_good', ny(9, 8, 20 + i), 'recognition', { source: 'textbook' }),
            ]
          : [answer(id, 'review_good', ny(9, 8, 10 + i), 'recognition', { source: 'textbook' })],
      ),
    ];
    const byKey = new Map(dueNow.map((c) => [`${c.item.kind}:${c.item.id}|${c.skill}`, c]));
    for (const ev of sitting) {
      const key = `${ev.item.kind}:${ev.item.id}|${ev.skill}`;
      const next = applyEvidence(byKey.get(key), ev, ev.at).card;
      if (next) byKey.set(key, next);
    }
    const after = buildLedger({
      cards: [...byKey.values()],
      evidence: [...learnt.evidence, ...sitting],
      knownItems: [],
      session: DEFAULT_SESSION_SETTINGS,
      masteryShare: 0.8,
      now: ny(9, 8, 30),
    });
    expect(after.thirstyWords()).toEqual([]);
    expect(after.status.dueNow).toBe(0);
    expect(buildPlants(after, lexicon, fsrs).filter((p) => p.dueCards.length > 0)).toEqual([]);
    expect(after.status.doneThisSession).toBe(10);
  });
});
