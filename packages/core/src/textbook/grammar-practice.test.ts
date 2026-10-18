import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import type { GrammarItem, Word } from '../types.js';
import {
  buildPointExercise,
  countPracticeSentences,
  grammarDistractorPool,
  grammarMeaningHint,
  grammarPracticeTiers,
  maskChinese,
  maskPattern,
  maskPatternFor,
  sentenceFitsGrammar,
  unknownWordsOf,
} from './grammar-practice.js';
import type { FillExercise, TileExercise } from './grammar-step.js';

const w = (headword: string, i: number): Word => ({
  id: `w${i}`,
  headword,
  variants: [],
  pos: [],
  level: 'N1',
  source: 'tocfl',
  pinyin: '',
  pinyinNumeric: '',
  zhuyin: '',
  glossEn: '',
  chars: [...headword],
  tags: [],
});
const WORDS = ['我', '你', '他', '剛剛', '剛', '在', '吃飯', '回家', '跟', '朋友', '一起', '還', '沒', '還是', '能', '可以', '也', '都', '去', '廁所', '嗎', '喝', '咖啡', '了', '會', '太', '先', '到', '學校', '媽媽'];
const lexicon = new Lexicon(WORDS.map(w), []);
const known = new Set(lexicon.allWords().filter((x) => x.headword !== '廁所').map((x) => x.id));

const item = (id: string, pattern: string, focus: string[], matcher: string, extra: Partial<GrammarItem> = {}): GrammarItem => ({
  id,
  pattern,
  level: 'N1',
  explanationEn: '',
  examples: [],
  focus,
  matcher,
  ...extra,
});
const GEN = item('gram-gen-yiqi', 'S + 跟 + someone + 一起 + V (O)', ['跟'], '跟.+一起', {
  explanationEn: '跟…一起 means "together with…" and goes before the main verb: 我跟朋友一起吃飯.',
  tags: ['textbook:laixue-1', 'textbook:laixue-1:L09'],
});
const HAI = item('gram-hai-still', 'S + 還 + V / Vs ；S + 還沒 / 還不 + V', ['還'], '還[^是]', {
  explanationEn: "還 before a verb means the action or state continues: 我還想喝咖啡. 還沒… says it has not happened yet.",
  level: 'L2',
});
const GANG = item('gram-ganggang-just', 'S + 剛剛 / 剛 + V (O)', ['剛剛', '剛'], '剛剛?.{1,8}', {
  level: 'L1',
  tags: ['supplement'],
  explanationEn: '剛剛 (or 剛) before a verb says the action happened just now, a very short time ago: 我剛剛到家. It goes after the subject and before the verb.',
  practice: [
    { zh: '他剛剛回家。', en: 'He just went home.' },
    { zh: '媽媽剛到學校。', en: 'Mom just got to the school.' },
  ],
});
const YE = item('gram-ye-also', 'S + 也 + V', ['也'], '也', { tags: ['textbook:laixue-1', 'textbook:laixue-1:L02'] });
const NENG = item('gram-neng-possibility', 'S + (Adv) + 能 + V (O)', ['能'], '能', { level: 'L1' });

const fill = (answer: string, options: string[]): FillExercise => ({
  type: 'fill',
  grammarId: 'g',
  sentenceId: 's',
  zh: '',
  before: '',
  answer,
  after: '',
  options,
});

describe('Phase 46 Part A: maskPattern', () => {
  it.each([
    // the owner's screenshot: 跟 is among the choices, so the pattern never shows it
    [GEN.pattern, '跟', ['跟', '也', '都', '還'], 'S + ＿＿ + someone + 一起 + V (O)'],
    // 還 inside 還沒 / 還不 is hidden too
    [HAI.pattern, '還', ['到', '還', '一', '先'], 'S + ＿＿ + V / Vs ；S + ＿＿沒 / ＿＿不 + V'],
    [GANG.pattern, '剛剛', ['剛剛', '一起', '還是', '都'], 'S + ＿＿ / ＿＿ + V (O)'],
    [NENG.pattern, '能', ['點', '太', '會', '能'], 'S + (Adv) + ＿＿ + V (O)'],
    // a distractor only hides a part that IS that choice (一 is not 一起)
    [GEN.pattern, '也', ['也', '一', '都'], 'S + 跟 + someone + 一起 + V (O)'],
  ])('%s, answer %s → %s', (pattern, answer, choices, want) => expect(maskPattern(pattern, answer, choices)).toBe(want));

  it('nothing useful left → undefined (the card hides the pattern until the answer)', () => {
    expect(maskPattern('了', '了', ['了', '過'])).toBeUndefined();
    expect(maskPattern('……，好不好？', ['好不好'], ['好不好', '對不對'])).toBeUndefined();
  });

  it('a tile exercise hides every part of the pattern its sentence uses', () => {
    const ex: TileExercise = {
      type: 'reorder',
      grammarId: GEN.id,
      sentenceId: 's',
      zh: '我跟朋友一起吃飯。',
      slots: [null, null, null, null, null, '。'],
      tiles: ['吃飯', '我', '一起', '跟', '朋友'],
      accepted: ['我跟朋友一起吃飯。'],
    };
    expect(maskPatternFor(GEN.pattern, ex)).toBe('S + ＿＿ + someone + ＿＿ + V (O)');
  });

  it('maskChinese leaves English alone', () => {
    expect(maskChinese('Use 跟 with 一起: 我跟朋友一起吃飯.', '跟', ['跟', '也'])).toBe('Use ＿＿ with 一起: 我＿＿朋友一起吃飯.');
  });

  it('the meaning hint is the first sentence, its Chinese example dropped, masked', () => {
    expect(grammarMeaningHint(GEN.explanationEn, fill('跟', ['跟', '也', '都']))).toBe(
      '＿＿…一起 means "together with…" and goes before the main verb.',
    );
    expect(grammarMeaningHint(GANG.explanationEn, fill('剛剛', ['剛剛', '一起', '都']))).toBe(
      '＿＿ (or ＿＿) before a verb says the action happened just now, a very short time ago.',
    );
    // never the answer
    expect(grammarMeaningHint(HAI.explanationEn, fill('還', ['還', '先', '到']))).not.toContain('還');
    expect(grammarMeaningHint('', fill('還', ['還']))).toBeUndefined();
  });
});

describe('Phase 46 Part B: every point can be practised', () => {
  const textbook: SentenceBankEntry[] = [];
  const bankEntry = (id: string, zh: string, extra: Partial<SentenceBankEntry> = {}): SentenceBankEntry =>
    ({ id, zh, en: 'x', targetWordId: '', level: 'N1', tokens: [], source: 'textbook', doubtful: false, ...extra }) as SentenceBankEntry;

  it('剛剛: the class example 我剛剛在吃飯 → 我＿＿在吃飯 with 剛剛 among the choices', () => {
    const ex = buildPointExercise(GANG.id, [GANG, GEN, HAI, NENG, YE], { textbook, classSentences: [{ id: 'c1', zh: '我剛剛在吃飯。', en: 'I was just eating.' }] }, { lexicon, seed: 's' });
    expect(ex?.type).toBe('fill');
    const f = ex as FillExercise;
    expect(f.before + '＿＿' + f.after).toBe('我＿＿在吃飯。');
    expect(f.answer).toBe('剛剛');
    expect(f.options).toContain('剛剛');
    // distractors never include the point's own other marker (剛 for 剛剛)
    expect(f.options).not.toContain('剛');
    expect(f.options.length).toBeGreaterThanOrEqual(3);
  });

  it('source order: textbook tagged, then the class, then the banks (supplement sentences, other textbook sentences)', () => {
    const tb = [
      bankEntry('t1', '我跟朋友一起吃飯。', { grammarIds: [GEN.id], lesson: 9, textbookId: 'laixue-1' }),
      bankEntry('t2', '你剛剛去學校嗎？', { lesson: 3 }),
      bankEntry('t3', '他剛剛去廁所。', { lesson: 4 }),
    ];
    const tiers = grammarPracticeTiers(GANG, { textbook: tb, classSentences: [{ id: 'c1', zh: '我剛剛在吃飯。', en: '' }], known: (id) => known.has(id) }, lexicon);
    expect(tiers.map((t) => t.map((s) => s.zh))).toEqual([
      [],
      ['我剛剛在吃飯。'],
      // 他剛剛去廁所 has one unknown word (廁所): still fine (≤ 1)
      ['他剛剛回家。', '媽媽剛到學校。', '你剛剛去學校嗎？', '他剛剛去廁所。'],
    ]);
    expect(countPracticeSentences(GANG, { textbook: tb }, lexicon)).toBe(4);
    // the textbook tier for a textbook point
    expect(grammarPracticeTiers(GEN, { textbook: tb }, lexicon)[0]!.map((s) => s.id)).toEqual(['t1']);
  });

  it('a bank sentence with two unknown words is left out; reported sentences never come back', () => {
    const k = (id: string) => known.has(id) && lexicon.byId(id)?.headword !== '咖啡';
    expect(unknownWordsOf('他剛剛去廁所喝咖啡。', lexicon, k)).toEqual(['廁所', '咖啡']);
    const tb = [bankEntry('t1', '他剛剛去廁所喝咖啡。'), bankEntry('t2', '他剛剛回家。')];
    const tiers = grammarPracticeTiers({ ...GANG, practice: [] }, { textbook: tb, known: k, excluded: new Set(['他剛剛回家。']) }, lexicon);
    expect(tiers.flat()).toEqual([]);
  });

  it('a sentence uses the point only with its marker inside the pattern span', () => {
    expect(sentenceFitsGrammar('我跟朋友一起吃飯。', GEN, lexicon)).toBe(true);
    expect(sentenceFitsGrammar('我跟朋友吃飯。', GEN, lexicon)).toBe(false);
    expect(sentenceFitsGrammar('你還是我？', HAI, lexicon)).toBe(false);
  });

  it('no sentence anywhere → no exercise (the step shows "No practice yet")', () => {
    expect(buildPointExercise(GANG.id, [{ ...GANG, practice: [] }], { textbook }, { lexicon, seed: 's' })).toBeUndefined();
  });

  it('distractors: a supplement point takes markers of points at or below its level, never its own', () => {
    const pool = grammarDistractorPool(GANG, [GANG, GEN, HAI, NENG, YE]);
    expect(pool).toEqual(expect.arrayContaining(['跟', '能', '也']));
    expect(pool).not.toContain('還'); // L2 is above 剛剛's L1
    expect(pool).not.toContain('剛');
  });
});
