import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import type { SkillCard } from '../learner/types.js';
import type { Word } from '../types.js';
import type { ChatLineSource } from './source.js';
import { buildSession, clozeAnswerEvidence, clozeSessionMeta, type BuildSessionOptions, type SessionItem } from './session.js';
import { CLOZE_CONFIG } from './cloze.config.js';
import { requeueAgain } from '../session/orderSession.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin: '',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

const NOW = new Date('2026-01-01');

function card(w: Word, overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    item: { kind: 'word', id: w.id },
    skill: 'recognition',
    card: emptyCard(NOW),
    state: 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: NOW,
    ...overrides,
  };
}

describe('buildSession', () => {
  it('skips grammar items (no word match) without crashing', () => {
    const w = word({ id: 'w1', headword: '貓' });
    const lexicon = new Lexicon([w]);
    const grammarCard: SkillCard = { ...card(w), item: { kind: 'grammar', id: 'gram-le' } };
    const items = buildSession([card(w), grammarCard], { lexicon, knownIds: new Set(), learnerLevel: 'N1' });
    expect(items).toHaveLength(1);
    expect(items[0]!.word.id).toBe(w.id);
  });

  it('maps clozeRung to the right exercise kind', () => {
    const words = ['w1', 'w2', 'w3'].map((id) => word({ id, headword: `字${id}` }));
    const lexicon = new Lexicon(words);
    const cards = [
      card(words[0]!, { clozeRung: 1 }),
      card(words[1]!, { clozeRung: 2 }),
      card(words[2]!, { clozeRung: 3 }),
    ];
    const items = buildSession(cards, { lexicon, knownIds: new Set(), learnerLevel: 'N1' });
    const byRung = Object.fromEntries(items.map((i) => [i.card.clozeRung, i.exerciseKind]));
    expect(byRung[1]).toBe('word_bank');
    expect(byRung[2]).toBe('multiple_choice');
    expect(byRung[3]).toBe('typed');
  });

  it('New (never answered) items come first and are not capped again here (Phase 29: the ledger caps them)', () => {
    const newWords = Array.from({ length: 3 }, (_, i) => word({ id: `new${i}`, headword: `新${i}` }));
    const reviewWords = Array.from({ length: 10 }, (_, i) => word({ id: `rev${i}`, headword: `舊${i}` }));
    const lexicon = new Lexicon([...newWords, ...reviewWords]);
    const cards = [
      ...newWords.map((w) => card(w, { state: 'introduced' })),
      ...reviewWords.map((w) => card(w, { state: 'review' })),
    ];
    const items = buildSession(cards, { lexicon, knownIds: new Set(), learnerLevel: 'N1', config: { maxItems: 5 } });
    expect(items.filter((i) => i.card.state === 'introduced')).toHaveLength(3);
    expect(items).toHaveLength(5);
  });

  it('respects maxItems overall', () => {
    const words = Array.from({ length: 30 }, (_, i) => word({ id: `w${i}`, headword: `字${i}` }));
    const lexicon = new Lexicon(words);
    const cards = words.map((w) => card(w, { state: 'review' }));
    const items = buildSession(cards, { lexicon, knownIds: new Set(), learnerLevel: 'N1', config: { maxItems: 20 } });
    expect(items.length).toBeLessThanOrEqual(20);
  });

  it('acceptance criterion: for a learner with chat history, >= 50% of session items come from their own chats', () => {
    // 10 due words; 6 of them appear in a seeded chat line (easy enough to
    // pass coverage: a single known filler word plus the target), 4 don't
    // appear anywhere (fall through to "none").
    const filler = word({ id: 'filler', headword: '好' });
    const CHARS = ['書', '筆', '燈', '椅', '窗', '門', '鞋', '傘', '車', '船'];
    const dueWords = CHARS.map((hw, i) => word({ id: `due${i}`, headword: hw }));
    const lexicon = new Lexicon([filler, ...dueWords]);
    const knownIds = new Set(['filler']);

    const chatLines: ChatLineSource[] = dueWords.slice(0, 6).map((w, i) => ({
      zh: `好${w.headword}`,
      role: 'learner' as const,
      scenarioTitle: 'tea-shop',
      at: new Date(NOW.getTime() + i * 1000),
    }));

    const cards = dueWords.map((w) => card(w, { state: 'review' }));
    const options: BuildSessionOptions = {
      lexicon,
      knownIds,
      learnerLevel: 'N1',
      chatLines,
      config: { maxItems: 20 },
    };
    const items = buildSession(cards, options);

    expect(items).toHaveLength(10);
    const fromChat = items.filter((i) => i.source?.sourceKind === 'chat').length;
    expect(fromChat / items.length).toBeGreaterThanOrEqual(0.5);
  });
});

describe('Phase 14: textbook-first rank', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => word({ id, headword: `字${id}` }));
  const lexicon = new Lexicon(words);
  const cards = words.map((w) => card(w));
  const opts = { lexicon, knownIds: new Set<string>(), learnerLevel: 'N1' as const, config: { maxItems: 3, maxErrorItems: 0 } };

  it('with a rank, the lowest-ranked review cards fill the limited slots', () => {
    const textbook = new Set(['d', 'e', 'f']);
    const items = buildSession(cards, { ...opts, rank: (c) => (textbook.has(c.item.id) ? 0 : 1) });
    expect(items.map((i) => i.word.id).sort()).toEqual(['d', 'e', 'f']);
  });

  it('without a rank nothing is forced', () => {
    const items = buildSession(cards, opts);
    expect(items).toHaveLength(3);
  });
});

describe('Phase 37: one cloze per word, no sentence twice', () => {
  const filler = word({ id: 'filler', headword: '好' });
  const CHARS = ['書', '筆', '燈', '椅', '窗', '門'];
  const words = CHARS.map((hw, i) => word({ id: `w${i}`, headword: hw }));
  const lexicon = new Lexicon([filler, ...words]);
  const bankSentences = words.map((w, i) => ({
    id: `s${i}`,
    zh: `好${w.headword}`,
    en: '',
    targetWordId: w.id,
    level: 'N1' as const,
    source: 'generated' as const,
  })) as unknown as BuildSessionOptions['bankSentences'];
  const opts: BuildSessionOptions = { lexicon, knownIds: new Set(['filler']), learnerLevel: 'N1', bankSentences, seed: 'p37' };
  const due = (days: number) => ({ ...emptyCard(NOW), due: new Date(NOW.getTime() - days * 86_400_000), reps: 3 });

  it("owner's case: 6 words with recognition and production in session give 6 questions, each its own sentence", () => {
    const cards = words.flatMap((w) => [card(w), card(w, { skill: 'production' })]);
    const items = buildSession(cards, opts);
    expect(items).toHaveLength(6);
    expect(new Set(items.map((i) => i.word.id)).size).toBe(6);
    expect(new Set(items.map((i) => i.source?.zh)).size).toBe(6);
    for (const i of items) expect(i.siblings).toHaveLength(1);
  });

  it('the exercise uses the most overdue card; production on a tie', () => {
    const [a, b] = words;
    const items = buildSession(
      [
        card(a!, { card: due(5) }),
        card(a!, { skill: 'production', card: due(1) }),
        card(b!, { card: due(2) }),
        card(b!, { skill: 'production', card: due(2) }),
      ],
      opts,
    );
    const byWord = new Map(items.map((i) => [i.word.id, i]));
    expect(byWord.get(a!.id)!.card.skill).toBe('recognition');
    expect(byWord.get(a!.id)!.siblings!.map((c) => c.skill)).toEqual(['production']);
    expect(byWord.get(b!.id)!.card.skill).toBe('production');
  });

  it('a word with a review card and a new card counts once (as a review word)', () => {
    const [a] = words;
    const items = buildSession([card(a!, { card: due(1) }), card(a!, { skill: 'production', state: 'introduced' })], opts);
    expect(items).toHaveLength(1);
    expect(items[0]!.card.skill).toBe('recognition');
  });

  it('two words whose only sentence is the same: one gets it, the other is left out (logged in the meta)', () => {
    const x = word({ id: 'x', headword: '貓' });
    const y = word({ id: 'y', headword: '狗' });
    const lex = new Lexicon([filler, x, y]);
    const shared = [
      { id: 'sx', zh: '貓狗', en: '', targetWordId: 'x', level: 'N1', source: 'generated' },
      { id: 'sy', zh: '貓狗', en: '', targetWordId: 'y', level: 'N1', source: 'generated' },
    ] as unknown as BuildSessionOptions['bankSentences'];
    const items = buildSession([card(x), card(y)], { ...opts, lexicon: lex, knownIds: new Set(['x', 'y', 'filler']), bankSentences: shared });
    expect(items).toHaveLength(1);
    expect(items[0]!.source?.zh).toBe('貓狗');
    const left = items[0]!.word.id === 'x' ? 'y' : 'x';
    expect(clozeSessionMeta(items)?.skippedNoFreshSentence).toEqual([left]);
  });

  it('two words sharing one sentence: the second uses its next candidate', () => {
    const x = word({ id: 'x', headword: '貓' });
    const y = word({ id: 'y', headword: '狗' });
    const lex = new Lexicon([filler, x, y]);
    const bank = [
      { id: 'sx', zh: '貓狗', en: '', targetWordId: 'x', level: 'N1', source: 'generated' },
      { id: 'sy', zh: '貓狗', en: '', targetWordId: 'y', level: 'N1', source: 'generated' },
      { id: 'sy2', zh: '好狗', en: '', targetWordId: 'y', level: 'N1', source: 'generated' },
      { id: 'sx2', zh: '好貓', en: '', targetWordId: 'x', level: 'N1', source: 'generated' },
    ] as unknown as BuildSessionOptions['bankSentences'];
    const items = buildSession([card(x), card(y)], { ...opts, lexicon: lex, knownIds: new Set(['x', 'y', 'filler']), bankSentences: bank });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.source?.zh)).size).toBe(2);
    expect(clozeSessionMeta(items)?.skippedNoFreshSentence).toEqual([]);
  });

  it('crediting: one evidence row per card of the word in this session (flag on), only the shown card (flag off)', () => {
    const [a] = words;
    const [item] = buildSession([card(a!), card(a!, { skill: 'production' })], opts);
    const on = clozeAnswerEvidence(item!, 'cloze_correct_nohint', NOW, { creditAllFacesOfWord: true });
    expect(on.map((e) => e.skill).sort()).toEqual(['production', 'recognition']);
    expect(on.every((e) => e.kind === 'cloze_correct_nohint' && e.item.id === a!.id)).toBe(true);
    const off = clozeAnswerEvidence(item!, 'cloze_correct_nohint', NOW, { creditAllFacesOfWord: false });
    expect(off).toEqual([{ item: item!.card.item, skill: item!.card.skill, kind: 'cloze_correct_nohint', at: NOW }]);
    expect(CLOZE_CONFIG.creditAllFacesOfWord).toBe(true);
  });

  it('a wrong answer still requeues once ("Again"), never side by side', () => {
    const cards = words.flatMap((w) => [card(w), card(w, { skill: 'production' })]);
    const items = buildSession(cards, opts);
    const describe = (i: SessionItem) => ({ keys: [`word:${i.word.id}`] });
    const after = requeueAgain(items, 0, describe);
    expect(after).toHaveLength(items.length + 1);
    const again = after.map((x, i) => [x.word.id, i] as const).filter(([id]) => id === items[0]!.word.id);
    expect(again).toHaveLength(2);
    expect(again[1]![1] - again[0]![1]).toBeGreaterThan(1);
  });
});
