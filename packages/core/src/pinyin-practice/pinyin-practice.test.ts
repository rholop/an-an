import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { ConfusableIndex } from '../confusables/index.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { SkillCard } from '../learner/types.js';
import { pinyinToZhuyin, toPinyinNumeric } from '../pinyin.js';
import type { Word } from '../types.js';
import { buildLedger } from '../progress/ledger.js';
import { DEFAULT_SESSION_SETTINGS } from '../progress/review-sessions.js';
import {
  gradeMatch,
  gradePick,
  gradeSort,
  gradeTones,
  gradeTypedReading,
  markTone,
  nearMissPinyin,
  planPinyinSession,
  practisable,
  readingEvidence,
  sandhiNotes,
  toneConfusions,
  tonePairs,
  wordSyllables,
  zhuyinWithTone,
  type PinyinExercise,
} from './index.js';

let n = 0;
function w(headword: string, pinyin: string, glossEn: string): Word {
  n += 1;
  return {
    id: `py-${n}-${headword}`,
    headword,
    variants: [],
    pos: ['N'],
    level: 'L1',
    source: 'tocfl',
    pinyin,
    pinyinNumeric: toPinyinNumeric(pinyin),
    zhuyin: pinyinToZhuyin(pinyin),
    glossEn,
    chars: [...headword],
    tags: [],
  };
}

const 老師 = w('老師', 'lǎo shī', 'teacher');
const 捷運 = w('捷運', 'jié yùn', 'MRT');
const 機車 = w('機車', 'jī chē', 'motor scooter');
const 便利商店 = w('便利商店', 'biàn lì shāng diàn', 'convenience store');
const 垃圾車 = w('垃圾車', 'lè sè chē', 'garbage truck');
const 不要 = w('不要', 'bù yào', "don't want");
const 一樣 = w('一樣', 'yī yàng', 'the same');
const 一起 = w('一起', 'yī qǐ', 'together');
const 你好 = w('你好', 'nǐ hǎo', 'hello');
const 第一 = w('第一', 'dì yī', 'first');
const 了 = w('了', 'le', '(completed action)');
const 買 = w('買', 'mǎi', 'to buy');
const 賣 = w('賣', 'mài', 'to sell');
const 是 = w('是', 'shì', 'to be');
const 事 = w('事', 'shì', 'matter');
const 市 = w('市', 'shì', 'city');
const 十 = w('十', 'shí', 'ten');
const 喝 = w('喝', 'hē', 'to drink');
const 渴 = w('渴', 'kě', 'thirsty');
const 己 = w('己', 'jǐ', 'oneself');
const 已 = w('已', 'yǐ', 'already');
const 巳 = w('巳', 'sì', 'sixth earthly branch');
const 末 = w('末', 'mò', 'end');
const 未 = w('未', 'wèi', 'not yet');
const 學生 = w('學生', 'xué shēng', 'student');
const 喜歡 = w('喜歡', 'xǐ huān', 'to like');
const 電腦 = w('電腦', 'diàn nǎo', 'computer');
const 朋友 = w('朋友', 'péng yǒu', 'friend');
const 中文 = w('中文', 'zhōng wén', 'Chinese language');
const 台灣 = w('台灣', 'tái wān', 'Taiwan');
const 飯店 = w('飯店', 'fàn diàn', 'hotel');
const 咖啡 = w('咖啡', 'kā fēi', 'coffee');

const ALL = [
  老師, 捷運, 機車, 便利商店, 垃圾車, 不要, 一樣, 一起, 你好, 第一, 了, 買, 賣, 是, 事, 市, 十, 喝, 渴, 己, 已, 巳, 末, 未,
  學生, 喜歡, 電腦, 朋友, 中文, 台灣, 飯店, 咖啡,
];

describe('pinyin & tones (Phase 23 Part C)', () => {
  it('tone marks go on the right vowel', () => {
    expect(markTone('lao', 3)).toBe('lǎo');
    expect(markTone('shi', 1)).toBe('shī');
    expect(markTone('liu', 2)).toBe('liú');
    expect(markTone('gui', 4)).toBe('guì');
    expect(markTone('nü', 3)).toBe('nǚ');
    expect(markTone('dou', 1)).toBe('dōu');
    expect(markTone('le', 5)).toBe('le');
    expect(zhuyinWithTone('ㄌㄠ', 3)).toBe('ㄌㄠˇ');
    expect(zhuyinWithTone('ㄌㄜ', 5)).toBe('˙ㄌㄜ');
  });

  it('syllables come from the MOE reading the app shows', () => {
    expect(wordSyllables(老師).map((s) => [s.char, s.base, s.tone, s.pinyin])).toEqual([
      ['老', 'lao', 3, 'lǎo'],
      ['師', 'shi', 1, 'shī'],
    ]);
    expect(wordSyllables(便利商店).map((s) => s.tone)).toEqual([4, 4, 1, 4]);
    expect(wordSyllables(了)[0]!.tone).toBe(5);
    expect(practisable(垃圾車)).toBe(true);
  });

  it('一 and 不 and 3rd + 3rd: the citation tone is asked, a note says what is said', () => {
    expect(sandhiNotes(不要)).toEqual(['不 is said bú before a 4th tone.']);
    expect(sandhiNotes(一樣)).toEqual(['一 is said yí before a 4th tone.']);
    expect(sandhiNotes(一起)).toEqual(['一 is said yì before a 3rd tone.']);
    expect(sandhiNotes(你好)).toEqual(['你 is said ní before another 3rd tone (nǐ hǎo → ní hǎo).']);
    expect(sandhiNotes(第一)).toEqual([]);
    expect(sandhiNotes(老師)).toEqual([]);
    // the citation tone is still the right answer
    expect(gradeTones(不要, [4, 4]).result.kind).toBe('reading_correct');
  });

  it('Pick the tones is graded per syllable', () => {
    const r = gradeTones(老師, [2, 1]);
    expect(r.wrongAt).toEqual([0]);
    expect(r.result).toEqual({ wordId: 老師.id, kind: 'reading_tone_wrong', tones: [{ expected: 3, given: 2 }] });
    expect(gradeTones(便利商店, [4, 4, 1, 4]).result.kind).toBe('reading_correct');
  });

  it('Type the pinyin: marks, numbers or zhuyin; right sound wrong tone is Hard', () => {
    expect(gradeTypedReading(老師, 'lao3 shi1').outcome).toBe('correct');
    expect(gradeTypedReading(老師, 'lǎo shī').outcome).toBe('correct');
    expect(gradeTypedReading(老師, 'ㄌㄠˇ ㄕ').outcome).toBe('correct');
    const t = gradeTypedReading(老師, 'lao2 shi1');
    expect(t.outcome).toBe('wrong_tone');
    expect(t.result).toMatchObject({ kind: 'reading_tone_wrong', tones: [{ expected: 3, given: 2 }] });
    expect(gradeTypedReading(老師, 'lao3 si1').outcome).toBe('wrong');
    expect(gradeTypedReading(老師, '老師').result.kind).toBe('reading_wrong'); // characters aren't a reading
  });

  it('Which pinyin is right? A near miss differs by one tone or one sound', () => {
    for (const word of [買, 是, 喝, 捷運, 機車]) {
      const miss = nearMissPinyin(word, 'seed');
      const right = wordSyllables(word).map((s) => ({ base: s.base, tone: s.tone }));
      expect(miss.syllables).not.toEqual(right);
      const diffs = miss.syllables.filter((s, i) => s.base !== right[i]!.base || s.tone !== right[i]!.tone);
      expect(diffs).toHaveLength(1);
      const graded = gradePick(word, { syllables: miss.syllables });
      expect(graded.kind).toBe(miss.kind === 'tone' ? 'reading_tone_wrong' : 'reading_wrong');
    }
    expect(gradePick(買, { syllables: [{ base: 'mai', tone: 4 }] })).toMatchObject({ kind: 'reading_tone_wrong', tones: [{ expected: 3, given: 4 }] });
  });

  it('Match and sort and picks', () => {
    expect(gradeMatch(買, 賣)).toMatchObject({ kind: 'reading_tone_wrong', pickedId: 賣.id });
    expect(gradeMatch(是, 事).kind).toBe('reading_correct'); // the same pinyin is right either way
    expect(gradeMatch(是, 喝)).toMatchObject({ kind: 'reading_wrong', pickedId: 喝.id });
    expect(gradeSort(捷運, '2 + 4').kind).toBe('reading_correct');
    expect(gradeSort(捷運, '3 + 4')).toMatchObject({ kind: 'reading_tone_wrong', tones: [{ expected: 2, given: 3 }] });
    expect(gradePick(是, { wordId: 事.id })).toMatchObject({ kind: 'reading_wrong', pickedId: 事.id });
  });

  it('tone stats: which tones are mixed up most', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const at = new Date('2026-10-07T12:00:00Z');
    const ev = [
      readingEvidence({ wordId: 'a', kind: 'reading_tone_wrong', tones: [{ expected: 2, given: 3 }] }, at),
      readingEvidence({ wordId: 'b', kind: 'reading_tone_wrong', tones: [{ expected: 3, given: 2 }, { expected: 1, given: 4 }] }, at),
      readingEvidence({ wordId: 'c', kind: 'reading_tone_wrong', tones: [{ expected: 2, given: 3 }] }, new Date('2026-09-01T00:00:00Z')),
    ];
    expect(tonePairs(toneConfusions(ev, now))).toEqual([
      { a: 2, b: 3, count: 2 },
      { a: 1, b: 4, count: 1 },
    ]);
  });

  it('reading cards schedule like other skills', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const unlocked = applyEvidence(undefined, { item: { kind: 'word', id: 老師.id }, skill: 'reading', kind: 'reading_unlocked', at: now }, now).card!;
    expect(unlocked).toMatchObject({ skill: 'reading', state: 'introduced' });
    const answered = applyEvidence(unlocked, readingEvidence({ wordId: 老師.id, kind: 'reading_correct' }, now), now).card!;
    expect(answered.card.reps).toBe(1);
    expect(answered.card.due.getTime()).toBeGreaterThan(now.getTime());
    expect(answered.source).toBe('study_order');
  });
});

describe('planPinyinSession', () => {
  const NOW = new Date('2026-10-08T12:00:00Z');
  const byId = new Map(ALL.map((x) => [x.id, x]));
  const reading = (word: Word, dueH: number, reps = 2): SkillCard => ({
    item: { kind: 'word', id: word.id },
    skill: 'reading',
    card: { ...createEmptyCard(NOW), due: new Date(NOW.getTime() + dueH * 3_600_000), reps, stability: 3 },
    state: reps === 0 ? 'introduced' : 'review',
    lapses: 0,
    leech: false,
    leechTreatmentsTried: [],
    clozeRung: 1,
    clozeStreak: 0,
    familiarity: 0,
    readingDependence: 0,
    flags: {},
    updatedAt: NOW,
  });
  const index = new ConfusableIndex(ALL);
  /** Phase 29: the reading queue comes from the ledger (session window + Pinyin allowance). */
  const queueOf = (cards: SkillCard[]) =>
    buildLedger({ cards, evidence: [], knownItems: [], session: DEFAULT_SESSION_SETTINGS, masteryShare: 0.9, now: NOW }).practice('reading');
  const kinds = (p: PinyinExercise[]) => new Set(p.map((e) => e.kind));
  const words = (p: PinyinExercise[]) => p.flatMap((e) => ('words' in e ? e.words : [e.word]));

  it('all seven exercises appear, every word once, up to the session size', () => {
    const cards = ALL.map((x) => reading(x, -1));
    const plan = planPinyinSession({ queue: queueOf(cards), wordById: (id) => byId.get(id), now: NOW, seed: 's1', confusables: index, preferred: new Set(ALL.map((x) => x.id)) });
    expect(kinds(plan)).toEqual(new Set(['tones', 'match', 'chars', 'type', 'which', 'sort', 'lookalike']));
    const ws = words(plan);
    expect(ws.length).toBe(30);
    expect(new Set(ws.map((x) => x.id)).size).toBe(ws.length);
  });

  it('the tone-pattern sort leaves out 一, 不 and 3rd + 3rd words', () => {
    const cards = ALL.map((x) => reading(x, -1));
    for (const seed of ['a', 'b', 'c']) {
      const sort = planPinyinSession({ queue: queueOf(cards), wordById: (id) => byId.get(id), now: NOW, seed, only: ['sort', 'tones'] }).find((e) => e.kind === 'sort');
      expect(sort).toBeDefined();
      const heads = (sort as Extract<PinyinExercise, { kind: 'sort' }>).words.map((x) => x.headword);
      for (const bad of ['不要', '一樣', '一起', '你好']) expect(heads).not.toContain(bad);
    }
  });

  it('cards in this session first, then trouble words, then New ones up to the Pinyin allowance (10); nothing else unless asked', () => {
    const cards = [
      reading(買, -2),
      reading(賣, 48), // not due, no trouble
      reading(喝, 48), // not due, but often wrong
      ...[是, 事, 市, 十, 渴, 己, 已, 巳, 末, 未, 學生, 喜歡].map((x) => reading(x, 0, 0)), // 12 New
    ];
    const plan = planPinyinSession({
      queue: queueOf(cards),
      wordById: (id) => byId.get(id),
      now: NOW,
      seed: 'x',
      trouble: new Map([[喝.id, 3]]),
      only: ['tones'],
    });
    const ids = words(plan).map((x) => x.id);
    expect(ids).toContain(買.id);
    expect(ids).toContain(喝.id);
    expect(ids).not.toContain(賣.id);
    expect(ids).toHaveLength(2 + 10);
    const extra = planPinyinSession({ queue: queueOf(cards), wordById: (id) => byId.get(id), now: NOW, seed: 'x', extra: true, only: ['tones'] });
    expect(words(extra).map((x) => x.id)).toContain(賣.id);
  });

  it('Pick the characters offers homophones with one right answer; look-alikes never share the reading', () => {
    const cards = ALL.map((x) => reading(x, -1));
    const plan = planPinyinSession({ queue: queueOf(cards), wordById: (id) => byId.get(id), now: NOW, seed: 'q', confusables: index, only: ['chars', 'lookalike'] });
    for (const e of plan) {
      if (e.kind !== 'chars' && e.kind !== 'lookalike') continue;
      expect(e.options).toHaveLength(4);
      expect(e.options.filter((o) => o.id === e.word.id)).toHaveLength(1);
      if (e.kind === 'lookalike') expect(e.options.filter((o) => o.pinyinNumeric === e.word.pinyinNumeric)).toHaveLength(1);
    }
  });
});
