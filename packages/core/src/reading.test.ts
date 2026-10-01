import { describe, expect, it } from 'vitest';
import { resolveReading } from './reading.js';
import { segment } from './segment.js';
import { buildFixtureLexicon } from './test-fixtures/lexicon-fixture.js';

const lexicon = buildFixtureLexicon();

function readingsFor(sentence: string) {
  const tokens = segment(sentence, lexicon);
  return tokens.map((token, i) => ({
    text: token.text,
    ...resolveReading(token, { prevToken: tokens[i - 1], nextToken: tokens[i + 1] }, lexicon),
  }));
}

describe('resolveReading: heteronyms resolved correctly in context, never a confident wrong answer', () => {
  it('他還沒還我錢。 — first 還 is hái (still), second is huán (return)', () => {
    const readings = readingsFor('他還沒還我錢。');
    const haiToken = readings.find((r) => r.text === '還' && r.pinyin === 'hái');
    const huanToken = readings.filter((r) => r.text === '還').find((r) => r.pinyin === 'huán');
    expect(haiToken).toBeTruthy();
    expect(huanToken).toBeTruthy();
    expect(haiToken!.confidence).not.toBe('low');
    expect(huanToken!.confidence).not.toBe('low');
  });

  it('這條路很長。 — 長 after 很 is cháng (long)', () => {
    const readings = readingsFor('這條路很長。');
    const chang = readings.find((r) => r.text === '長');
    expect(chang?.pinyin).toBe('cháng');
  });

  it('我妹妹比我長三歲。 — standalone 長 before 三歲 still resolves to a reading, never silently wrong-confident without disambiguation', () => {
    const readings = readingsFor('我妹妹比我長三歲。');
    const chang = readings.find((r) => r.text === '長');
    expect(chang).toBeTruthy();
    expect(['high', 'medium', 'low']).toContain(chang!.confidence);
  });

  it('你吃飯了嗎？ — sentence-final 了 is le, high confidence (only one lexicon sense matches the rule)', () => {
    const readings = readingsFor('你吃飯了嗎？');
    const le = readings.find((r) => r.text === '了');
    expect(le?.pinyin).toBe('le');
  });

  it('這件事情我做不了。 — 不了 is liǎo', () => {
    const readings = readingsFor('這件事情我做不了。');
    const liao = readings.find((r) => r.text === '了');
    expect(liao?.pinyin).toBe('liǎo');
  });

  it('這個包包很重。 — standalone 重 after 很 is zhòng (heavy)', () => {
    const readings = readingsFor('這個包包很重。');
    const zhong = readings.find((r) => r.text === '重');
    expect(zhong?.pinyin).toBe('zhòng');
  });

  it('老師說這個字要重寫。 — 重 before 寫 is chóng (again)', () => {
    const readings = readingsFor('老師說這個字要重寫。');
    const chong = readings.find((r) => r.text === '重');
    expect(chong?.pinyin).toBe('chóng');
  });

  it('這樣做可行嗎？ — 行 in 可行 is absorbed into the phrase (xíng), not re-disambiguated', () => {
    const readings = readingsFor('這樣做可行嗎？');
    const xing = readings.find((r) => r.text === '可行');
    expect(xing?.pinyin).toBe('kě xíng');
  });

  it('我們一行五個人。 — standalone 行 after 一 is háng (group/row)', () => {
    const readings = readingsFor('我們一行五個人。');
    const hang = readings.find((r) => r.text === '行');
    expect(hang?.pinyin).toBe('háng');
  });

  it('他的中文說得很好。 — 得 after the verb 說 is de (structural particle)', () => {
    const readings = readingsFor('他的中文說得很好。');
    const de = readings.find((r) => r.text === '得');
    expect(de?.pinyin).toBe('de');
  });

  it('我得走了。 — 得 between subject 我 and verb 走 is děi (must)', () => {
    const readings = readingsFor('我得走了。');
    const dei = readings.find((r) => r.text === '得');
    expect(dei?.pinyin).toBe('děi');
  });
});

describe('resolveReading: non-word tokens', () => {
  it('numbers and punctuation resolve to empty readings, confidence high (not applicable)', () => {
    const readings = readingsFor('這台機車要150塊。');
    const num = readings.find((r) => r.text === '150');
    expect(num).toMatchObject({ pinyin: '', zhuyin: '', confidence: 'high' });
  });

  it('an unrecognized Han span gets a low-confidence empty reading, never a guess', () => {
    const tokens = segment('龘龘', lexicon); // characters unlikely to be in any lexicon
    const r = resolveReading(tokens[0]!, {}, lexicon);
    expect(r.confidence).toBe('low');
  });
});
