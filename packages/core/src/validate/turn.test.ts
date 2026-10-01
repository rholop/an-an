import { describe, expect, it } from 'vitest';
import { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';
import { analyzeText, DEFAULT_VALIDATE_CONFIG, locateHints, validateTurnResponse, type AnalyzeContext } from './turn.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword' | 'pinyin'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: null,
    source: 'tocfl',
    pinyinNumeric: '',
    zhuyin: '',
    glossEn: '',
    chars: [...partial.headword],
    tags: [],
    ...partial,
  };
}

const KNOWN_WORD = word({ id: 'w-wo', headword: '我', pinyin: 'wǒ', level: 'N1' });
const PARTICLE = word({ id: 'w-de', headword: '的', pinyin: 'de', level: 'N1', tags: ['particle'] });
const TARGET_WORD = word({ id: 'w-shaobing', headword: '少冰', pinyin: 'shǎo bīng', level: 'N2' });
const DUE_WORD = word({ id: 'w-weitang', headword: '微糖', pinyin: 'wéi táng', level: 'N2' });
const OUT_OF_LEVEL_WORD = word({ id: 'w-mao', headword: '貓', pinyin: 'māo', level: 'L5' });
const UNLISTED_WORD = word({ id: 'w-zhexue', headword: '哲學', pinyin: 'zhé xué', level: 'N2' });
const NAME_WORD = word({ id: 'w-npc', headword: '陳雅婷', pinyin: 'Chén Yǎtíng', level: null, source: 'supplement', tags: ['name', 'npc'] });
const SIMPLIFIED_UNLISTED = word({ id: 'w-ditie', headword: '地鐵', pinyin: 'dì tiě', level: 'N2' });

const lexicon = new Lexicon([
  KNOWN_WORD,
  PARTICLE,
  TARGET_WORD,
  DUE_WORD,
  OUT_OF_LEVEL_WORD,
  UNLISTED_WORD,
  NAME_WORD,
  SIMPLIFIED_UNLISTED,
]);

function baseContext(overrides: Partial<AnalyzeContext> = {}): AnalyzeContext {
  return {
    lexicon,
    learnerLevel: 'N2',
    knownIds: new Set([KNOWN_WORD.id]),
    dueIds: new Set([DUE_WORD.id]),
    targetIds: new Set([TARGET_WORD.id]),
    learningIds: new Set(),
    allowedExtraIds: new Set(),
    ...overrides,
  };
}

describe('analyzeText: token classification', () => {
  it('classifies known/due/target/allowed(particle)/out_of_level/unlisted correctly', () => {
    const text = '我的少冰微糖貓哲學';
    const result = analyzeText(text, baseContext());
    const byHeadword = new Map(result.classifications.map((c) => [c.token.text, c.class]));
    expect(byHeadword.get('我')).toBe('known');
    expect(byHeadword.get('的')).toBe('allowed');
    expect(byHeadword.get('少冰')).toBe('target');
    expect(byHeadword.get('微糖')).toBe('due');
    expect(byHeadword.get('貓')).toBe('out_of_level');
    expect(byHeadword.get('哲學')).toBe('unlisted');
  });

  it('classifies a name/NPC-tagged word as allowed even though it is not in any tracked set', () => {
    const result = analyzeText('陳雅婷', baseContext());
    expect(result.classifications[0]!.class).toBe('allowed');
  });

  it('excludes numbers/latin/punctuation from the content-token denominator', () => {
    const result = analyzeText('我150Hello！', baseContext());
    // only "我" should be a classified content token
    expect(result.classifications).toHaveLength(1);
    expect(result.classifications[0]!.token.text).toBe('我');
  });

  it('classifies an unrecognized (OOV) Han span as unlisted', () => {
    const result = analyzeText('龘龘', baseContext());
    expect(result.classifications.every((c) => c.class === 'unlisted')).toBe(true);
  });

  it('reports maxLevel as the highest level among classified tokens', () => {
    const result = analyzeText('我貓', baseContext());
    expect(result.maxLevel).toBe('L5');
  });

  it('coverage is 1 and pass is true for empty/non-content text (no content tokens)', () => {
    const result = analyzeText('150！', baseContext());
    expect(result.coverage).toBe(1);
    expect(result.classifications).toHaveLength(0);
  });
});

describe('analyzeText: pass/fail fixtures (phase-3 acceptance criteria)', () => {
  const repeat = (s: string, n: number) => s.repeat(n);

  it('PASS: mostly-known reply with a couple of targets clears the default threshold', () => {
    // 20 known tokens + 1 target -> coverage 20/21 ≈ 0.952 >= 0.95, unknown count 1 <= 4.
    const text = repeat('我', 20) + '少冰';
    const result = analyzeText(text, baseContext());
    expect(result.coverage).toBeGreaterThanOrEqual(DEFAULT_VALIDATE_CONFIG.coverageThreshold);
    expect(result.unknown).toHaveLength(1);
    expect(result.pass).toBe(true);
  });

  it('FAIL on coverage: too many out-of-level/unlisted words drags coverage under threshold', () => {
    const text = repeat('我', 5) + repeat('貓', 10);
    const result = analyzeText(text, baseContext());
    expect(result.coverage).toBeLessThan(DEFAULT_VALIDATE_CONFIG.coverageThreshold);
    expect(result.pass).toBe(false);
  });

  it('FAIL on too many unknown tokens even if coverage ratio alone is borderline-high', () => {
    // 96 known + 5 targets: coverage 96/101 ≈ 0.95 (at/near threshold) but
    // unknown count 5 > maxUnknownTokens (4) — must still fail.
    const text = repeat('我', 96) + repeat('少冰', 5);
    const result = analyzeText(text, baseContext());
    expect(result.unknown.length).toBeGreaterThan(DEFAULT_VALIDATE_CONFIG.maxUnknownTokens);
    expect(result.pass).toBe(false);
  });

  it('FAIL on a mainland term, even in an otherwise short/clean reply', () => {
    const text = '我要坐地鐵。'; // 地鐵 is in CLAUDE.md's own mainland-terms example list
    const result = analyzeText(text, baseContext());
    expect(result.taiwanness.isClean).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('FAIL on a simplified character, even in an otherwise short/clean reply', () => {
    const text = '我们好。'; // 们 is simplified-only
    const result = analyzeText(text, baseContext());
    expect(result.taiwanness.isClean).toBe(false);
    expect(result.pass).toBe(false);
  });

  it('PASS with names and numbers: an NPC name + digits do not count against coverage', () => {
    const text = repeat('我', 18) + '陳雅婷150少冰';
    const result = analyzeText(text, baseContext());
    expect(result.pass).toBe(true);
    expect(result.classifications.some((c) => c.token.text === '陳雅婷' && c.class === 'allowed')).toBe(true);
  });
});

describe('locateHints', () => {
  it('finds each hint text in order and returns matching offsets', () => {
    const text = '我要一杯少冰奶茶';
    const hints = locateHints(text, ['我', '要', '一杯', '少冰', '奶茶']);
    expect(hints).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
      { start: 6, end: 8 },
    ]);
  });

  it('skips a hint that cannot be found, without throwing', () => {
    const hints = locateHints('我要奶茶', ['我', '不存在的詞', '奶茶']);
    expect(hints).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4 },
    ]);
  });

  it('returns [] for no hints', () => {
    expect(locateHints('我要奶茶', [])).toEqual([]);
  });
});

describe('validateTurnResponse', () => {
  it('uses the response tokens as segmentation hints and validates reply_zh', () => {
    const response = {
      reply_zh: '我'.repeat(20) + '少冰',
      tokens: [{ text: '我' }, { text: '少冰', lemma: '少冰' }],
    };
    const result = validateTurnResponse(response, baseContext());
    expect(result.pass).toBe(true);
  });

  it('still fails a response with a mainland term regardless of its token hints', () => {
    const response = { reply_zh: '我要坐地鐵。', tokens: [{ text: '地鐵' }] };
    const result = validateTurnResponse(response, baseContext());
    expect(result.pass).toBe(false);
  });
});
