import { describe, expect, it } from 'vitest';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import { buildFixtureLexicon } from '../test-fixtures/lexicon-fixture.js';
import type { Level } from '../types.js';
import {
  buildReaderGenRequest,
  evaluateReaderSentence,
  hashReaderText,
  pickGenerationWord,
  readerSentencesFromChat,
  readerSentencesFromJournal,
  selectLocalReaderSentence,
  READER_REPEAT_WINDOW_MS,
  type ReaderLearnerState,
  type ReaderSentence,
} from './select.js';

const lexicon = buildFixtureLexicon();
const id = (hw: string) => lexicon.lookup(hw)[0]!.id;
const ids = (...hws: string[]) => new Set(hws.map(id));
const NOW = new Date('2026-03-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const KNOWN = ids('我', '你', '去', '喜歡', '咖啡', '很', '吃', '飯', '喝', '是', '好', '今天', '家', '大');

function state(over: Partial<ReaderLearnerState> = {}): ReaderLearnerState {
  return {
    lexicon,
    learnerLevel: 'L2' as Level,
    knownIds: KNOWN,
    dueIds: new Set(),
    learningIds: new Set(),
    frontier: [],
    ...over,
  };
}

let n = 0;
function entry(zh: string, target: string, over: Partial<SentenceBankEntry> = {}): SentenceBankEntry {
  n += 1;
  return {
    id: `s${n}`,
    zh,
    en: `english ${n}`,
    targetWordId: id(target),
    level: 'N1',
    tokens: [],
    source: 'generated',
    doubtful: false,
    ...over,
  };
}
const seeded = () => {
  let x = 7;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
};
const noShown = new Map<string, number>();

describe('evaluateReaderSentence', () => {
  it('passes a sentence made of known words plus one due word (mixed)', () => {
    const st = state({ dueIds: ids('便利商店') });
    const ev = evaluateReaderSentence('我去便利商店', 'mixed', st);
    expect(ev.exact).toBe(true);
    expect(ev.focusWordId).toBe(id('便利商店'));
    expect(ev.coverage).toBe(1);
  });

  it('mixed needs 1–2 due/learning words, not 0 and not 3', () => {
    const st = state({ dueIds: ids('便利商店', '機車', '夜市') });
    expect(evaluateReaderSentence('我喜歡咖啡', 'mixed', st).exact).toBe(false); // none
    expect(evaluateReaderSentence('我去便利商店', 'mixed', st).exact).toBe(true); // one
    expect(evaluateReaderSentence('我去便利商店夜市', 'mixed', st).exact).toBe(true); // two
    expect(evaluateReaderSentence('我去便利商店夜市機車', 'mixed', st).exact).toBe(false); // three
  });

  it('review always requires a due word when one exists', () => {
    const st = state({ dueIds: ids('便利商店'), learningIds: ids('夜市') });
    expect(evaluateReaderSentence('我去夜市', 'review', st).exact).toBe(false); // learning only
    expect(evaluateReaderSentence('我去便利商店', 'review', st).exact).toBe(true);
  });

  it('review falls back to a learning word when nothing is due, and to anything when nothing is learned', () => {
    expect(evaluateReaderSentence('我去夜市', 'review', state({ learningIds: ids('夜市') })).exact).toBe(true);
    expect(evaluateReaderSentence('我喜歡咖啡', 'review', state()).exact).toBe(true);
  });

  it('new words needs exactly one frontier word', () => {
    const st = state({ frontier: [lexicon.byId(id('垃圾車'))!, lexicon.byId(id('夜市'))!] });
    const one = evaluateReaderSentence('我去垃圾車', 'new', st);
    expect(one.exact).toBe(true);
    expect(one.focusWordId).toBe(id('垃圾車'));
    expect(evaluateReaderSentence('我喜歡咖啡', 'new', st).exact).toBe(false); // none
    expect(evaluateReaderSentence('垃圾車夜市', 'new', st).exact).toBe(false); // two
  });

  it('rejects a sentence with too many unknown words or below 95% coverage', () => {
    const st = state({ dueIds: ids('便利商店') });
    // 便利商店 (due) + 3 unknown content words
    const ev = evaluateReaderSentence('便利商店機車夜市垃圾車', 'mixed', st);
    expect(ev.exact).toBe(false);
    expect(ev.unknownCount).toBe(3);
    // 1 unknown in a short sentence is < 95% known
    expect(evaluateReaderSentence('我去便利商店機車', 'mixed', st).exact).toBe(false);
  });

  it('rejects simplified characters and mainland terms', () => {
    const st = state();
    expect(evaluateReaderSentence('我喜欢咖啡', 'mixed', st).exact).toBe(false);
  });
});

describe('selectLocalReaderSentence', () => {
  const base = (over: Partial<Parameters<typeof selectLocalReaderSentence>[0]> = {}) => ({
    state: state({ dueIds: ids('便利商店') }),
    focus: 'mixed' as const,
    bank: [] as SentenceBankEntry[],
    own: [] as ReaderSentence[],
    shown: noShown,
    now: NOW,
    rand: seeded(),
    ...over,
  });

  it('picks a bank sentence containing the due word, with the reason line', () => {
    const bank = [entry('我去便利商店', '便利商店'), entry('我喜歡咖啡', '咖啡')];
    const r = selectLocalReaderSentence(base({ bank }));
    expect(r.exact?.sentence.zh).toBe('我去便利商店');
    expect(r.exact?.reason).toBe('Practising 便利商店 (in this review session)');
    expect(r.exact?.sentence.source).toBe('bank');
  });

  it('ignores bank sentences above the current level, and changing level changes the result', () => {
    const bank = [entry('我去便利商店', '便利商店', { level: 'L4' })];
    expect(selectLocalReaderSentence(base({ bank })).exact).toBeNull();
    const higher = selectLocalReaderSentence(base({ bank, state: state({ learnerLevel: 'L4', dueIds: ids('便利商店') }) }));
    expect(higher.exact?.sentence.zh).toBe('我去便利商店');
  });

  it('does not repeat a sentence shown within 7 days while a fresh one exists', () => {
    const a = entry('我去便利商店', '便利商店');
    const b = entry('我今天去便利商店', '便利商店');
    const shown = new Map([[a.id, NOW.getTime() - 2 * DAY]]);
    for (let seed = 1; seed <= 20; seed++) {
      let x = seed;
      const r = selectLocalReaderSentence(base({ bank: [a, b], shown, rand: () => (x = (x * 16807) % 2147483647) / 2147483647 }));
      expect(r.exact?.sentence.id).toBe(b.id);
    }
  });

  it('a sentence shown more than 7 days ago is fresh again', () => {
    const a = entry('我去便利商店', '便利商店');
    const shown = new Map([[a.id, NOW.getTime() - READER_REPEAT_WINDOW_MS - 1]]);
    expect(selectLocalReaderSentence(base({ bank: [a], shown })).exact?.sentence.id).toBe(a.id);
  });

  it('when every exact sentence was shown recently, offers the oldest as repeatExact, not exact', () => {
    const a = entry('我去便利商店', '便利商店');
    const b = entry('我今天去便利商店', '便利商店');
    const shown = new Map([
      [a.id, NOW.getTime() - 1 * DAY],
      [b.id, NOW.getTime() - 3 * DAY],
    ]);
    const r = selectLocalReaderSentence(base({ bank: [a, b], shown }));
    expect(r.exact).toBeNull();
    expect(r.repeatExact?.sentence.id).toBe(b.id);
  });

  it('falls back to the learner’s own chat lines when the bank has nothing', () => {
    const own = readerSentencesFromChat([
      { zh: '我去便利商店。', role: 'learner', scenarioTitle: 'Tea shop', at: NOW },
    ]);
    const r = selectLocalReaderSentence(base({ own }));
    expect(r.exact?.sentence.source).toBe('chat');
    expect(r.exact?.sentence.sourceLabel).toBe('From your own reply in Tea shop');
  });

  it('prefers the bank over own lines', () => {
    const bank = [entry('我去便利商店', '便利商店')];
    const own = readerSentencesFromJournal([{ zh: '今天我去便利商店', at: NOW }]);
    expect(selectLocalReaderSentence(base({ bank, own })).exact?.sentence.source).toBe('bank');
  });

  it('returns the closest sentence (inexact) when nothing meets the rule', () => {
    const bank = [
      entry('便利商店機車夜市垃圾車', '便利商店'), // 3 unknown
      entry('我去便利商店機車', '便利商店'), // 1 unknown, short
    ];
    const r = selectLocalReaderSentence(base({ bank }));
    expect(r.exact).toBeNull();
    expect(r.closest?.exact).toBe(false);
    expect(r.closest?.sentence.zh).toBe('我去便利商店機車');
  });

  it('review focus never shows a sentence without a due word as exact', () => {
    const bank = [entry('我喜歡咖啡', '咖啡'), entry('我去便利商店', '便利商店')];
    for (let seed = 1; seed <= 10; seed++) {
      let x = seed;
      const r = selectLocalReaderSentence(
        base({ bank, focus: 'review', rand: () => (x = (x * 16807) % 2147483647) / 2147483647 }),
      );
      expect(r.exact?.sentence.zh).toBe('我去便利商店');
    }
  });

  it('new focus picks a sentence with exactly one frontier word', () => {
    const st = state({ frontier: [lexicon.byId(id('垃圾車'))!] });
    const bank = [entry('我去垃圾車', '垃圾車'), entry('我喜歡咖啡', '咖啡')];
    const r = selectLocalReaderSentence({ state: st, focus: 'new', bank, own: [], shown: noShown, now: NOW, rand: seeded() });
    expect(r.exact?.sentence.zh).toBe('我去垃圾車');
    expect(r.exact?.reason).toBe('New word: 垃圾車');
  });

  it('mixed with nothing due or learning accepts any comprehensible sentence', () => {
    const bank = [entry('我喜歡咖啡', '咖啡')];
    const r = selectLocalReaderSentence(base({ bank, state: state() }));
    expect(r.exact?.reason).toBe('Mostly words you know');
  });

  it('twenty presses in a row, using only local pools, always yield a rule-meeting or labelled sentence', () => {
    const bank = [
      entry('我去便利商店', '便利商店'),
      entry('我今天去便利商店', '便利商店'),
      entry('我喜歡去便利商店', '便利商店'),
    ];
    const own = readerSentencesFromChat([
      { zh: '你好嗎。我今天去便利商店喝咖啡。', role: 'npc', scenarioTitle: 'Shop', npcName: '阿美', at: NOW },
    ]);
    const shown = new Map<string, number>();
    const rand = seeded();
    for (let i = 0; i < 20; i++) {
      const sel = selectLocalReaderSentence(base({ bank, own, shown, rand }));
      const pick = sel.exact ?? sel.repeatExact ?? sel.closest;
      expect(pick).not.toBeNull();
      if (pick!.exact) {
        const ev = evaluateReaderSentence(pick!.sentence.zh, 'mixed', base().state);
        expect(ev.exact).toBe(true);
      }
      shown.set(pick!.sentence.id, NOW.getTime() + i);
    }
  });
});

describe('own-line shaping', () => {
  it('splits a chat turn into sentences, keeps its English only for single-sentence turns, and dedupes', () => {
    const lines = readerSentencesFromChat([
      { zh: '你好嗎。我今天去便利商店。', en: 'whole turn', role: 'npc', scenarioTitle: 'Shop', npcName: '阿美', at: NOW },
      { zh: '我今天去便利商店。', en: 'one sentence', role: 'npc', scenarioTitle: 'Shop', npcName: '阿美', at: NOW },
    ]);
    expect(lines.map((l) => l.zh)).toEqual(['你好嗎。', '我今天去便利商店。']);
    expect(lines[0]!.en).toBeUndefined();
    expect(lines[0]!.sourceLabel).toBe('From your chat with 阿美 (Shop)');
    expect(lines[1]!.id).toBe(`chat-${hashReaderText('我今天去便利商店。')}`);
  });

  it('drops fragments and very long lines', () => {
    expect(readerSentencesFromChat([{ zh: '好。', role: 'npc', scenarioTitle: 'S', at: NOW }])).toEqual([]);
    expect(readerSentencesFromJournal([{ zh: '我'.repeat(41), at: NOW }])).toEqual([]);
  });
});

describe('live generation helpers', () => {
  it('builds the /v1/sentences request from the focus word and a sample of known words', () => {
    const st = state({ dueIds: ids('便利商店') });
    const word = lexicon.byId(id('便利商店'))!;
    const req = buildReaderGenRequest(word, st, seeded(), 5);
    expect(req.word.headword).toBe('便利商店');
    expect(req.count).toBe(3);
    expect(req.allowedVocab).toHaveLength(5);
    expect(req.allowedVocab).not.toContain('便利商店');
  });

  it('chooses a due word for review, a frontier word for new, and falls back to the frontier', () => {
    const frontier = [lexicon.byId(id('垃圾車'))!];
    const st = state({ dueIds: ids('便利商店'), frontier });
    expect(pickGenerationWord('review', st)?.headword).toBe('便利商店');
    expect(pickGenerationWord('new', st)?.headword).toBe('垃圾車');
    expect(pickGenerationWord('mixed', state({ frontier }))?.headword).toBe('垃圾車');
    expect(pickGenerationWord('mixed', state())).toBeUndefined();
  });
});
