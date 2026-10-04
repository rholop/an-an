import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import type { SkillCard } from '../learner/types.js';
import type { Word } from '../types.js';
import type { ChatLineSource } from './source.js';
import { buildSession, type BuildSessionOptions } from './session.js';

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

  it('caps new (not-yet-review) items separately from review items', () => {
    const newWords = Array.from({ length: 10 }, (_, i) => word({ id: `new${i}`, headword: `新${i}` }));
    const reviewWords = Array.from({ length: 10 }, (_, i) => word({ id: `rev${i}`, headword: `舊${i}` }));
    const lexicon = new Lexicon([...newWords, ...reviewWords]);
    const cards = [
      ...newWords.map((w) => card(w, { state: 'learning' })),
      ...reviewWords.map((w) => card(w, { state: 'review' })),
    ];
    const items = buildSession(cards, {
      lexicon,
      knownIds: new Set(),
      learnerLevel: 'N1',
      config: { maxItems: 20, maxNewItems: 3 },
    });
    const newCount = items.filter((i) => i.card.state === 'learning').length;
    expect(newCount).toBeLessThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(20);
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
      config: { maxItems: 20, maxNewItems: 0 },
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
  const opts = { lexicon, knownIds: new Set<string>(), learnerLevel: 'N1' as const, config: { maxItems: 3, maxNewItems: 0, maxErrorItems: 0 } };

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
