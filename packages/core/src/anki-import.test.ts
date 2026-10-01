import { describe, expect, it } from 'vitest';
import {
  buildCustomWord,
  matchAnkiRows,
  parseDelimitedText,
  summarizeAnkiMatch,
} from './anki-import.js';
import { Lexicon } from './lexicon.js';
import type { Word } from './types.js';

function word(partial: Partial<Word> & Pick<Word, 'id' | 'headword'>): Word {
  return {
    variants: [],
    pos: ['N'],
    level: null,
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

describe('parseDelimitedText', () => {
  it('splits a plain Anki tab export into rows/fields', () => {
    const raw = '你好\tnǐ hǎo\thello\n貓\tmāo\tcat\n';
    expect(parseDelimitedText(raw)).toEqual([
      ['你好', 'nǐ hǎo', 'hello'],
      ['貓', 'māo', 'cat'],
    ]);
  });

  it('strips Anki #-prefixed metadata lines', () => {
    const raw = '#separator:tab\n#html:true\n你好\tnǐ hǎo\thello\n';
    expect(parseDelimitedText(raw)).toEqual([['你好', 'nǐ hǎo', 'hello']]);
  });

  it('detects comma delimiter when no tabs are present', () => {
    const raw = '你好,nǐ hǎo,hello\n貓,māo,cat\n';
    expect(parseDelimitedText(raw)).toEqual([
      ['你好', 'nǐ hǎo', 'hello'],
      ['貓', 'māo', 'cat'],
    ]);
  });

  it('handles quoted CSV fields containing the delimiter and escaped quotes', () => {
    const raw = '你好,"nǐ hǎo, informal","she said ""hi"""\n';
    expect(parseDelimitedText(raw)).toEqual([['你好', 'nǐ hǎo, informal', 'she said "hi"']]);
  });

  it('skips blank lines', () => {
    const raw = '你好\tnǐ hǎo\n\n貓\tmāo\n';
    expect(parseDelimitedText(raw)).toHaveLength(2);
  });

  it('returns [] for empty input', () => {
    expect(parseDelimitedText('')).toEqual([]);
  });
});

describe('matchAnkiRows', () => {
  const lexicon = new Lexicon([
    word({ id: 'w1', headword: '你好', variants: ['妳好'] }),
    word({ id: 'w2', headword: '長', pinyin: 'cháng' }),
    word({ id: 'w3', headword: '長', pinyin: 'zhǎng', freqRank: 50 }),
  ]);

  it('matches a row by exact headword', () => {
    const [result] = matchAnkiRows([['你好', 'extra']], 0, lexicon);
    expect(result).toMatchObject({ status: 'matched', headword: '你好' });
    expect(result!.word?.id).toBe('w1');
  });

  it('matches a row by variant spelling', () => {
    const [result] = matchAnkiRows([['妳好']], 0, lexicon);
    expect(result).toMatchObject({ status: 'matched' });
    expect(result!.word?.id).toBe('w1');
  });

  it('flags ambiguous when multiple senses share the headword, auto-picking the lowest freqRank', () => {
    const [result] = matchAnkiRows([['長']], 0, lexicon);
    expect(result!.status).toBe('ambiguous');
    expect(result!.candidates).toHaveLength(2);
    expect(result!.word?.id).toBe('w3'); // only candidate with a defined freqRank
  });

  it('flags unmatched for a headword not in the lexicon', () => {
    const [result] = matchAnkiRows([['不存在的詞']], 0, lexicon);
    expect(result!.status).toBe('unmatched');
    expect(result!.word).toBeUndefined();
  });

  it('flags unmatched (not a crash) for a blank cell or a row shorter than the column index', () => {
    expect(matchAnkiRows([['']], 0, lexicon)[0]!.status).toBe('unmatched');
    expect(matchAnkiRows([[]], 2, lexicon)[0]!.status).toBe('unmatched');
  });

  it('reads whichever column index is configured as the headword column', () => {
    const [result] = matchAnkiRows([['nǐ hǎo', '你好']], 1, lexicon);
    expect(result!.status).toBe('matched');
  });
});

describe('summarizeAnkiMatch', () => {
  const lexicon = new Lexicon([word({ id: 'w1', headword: '你好' })]);

  it('tallies a mixed batch correctly, matching a realistic 3000-row-scale shape', () => {
    const rows = [['你好'], ['不存在'], ['你好']];
    const results = matchAnkiRows(rows, 0, lexicon);
    expect(summarizeAnkiMatch(results)).toEqual({ total: 3, matched: 2, ambiguous: 0, unmatched: 1 });
  });
});

describe('buildCustomWord', () => {
  it('builds a source:"custom" word with a deterministic id', () => {
    const a = buildCustomWord('newword', 'xīnzì', 'a new word');
    const b = buildCustomWord('newword', 'xīnzì', 'a new word');
    expect(a.id).toBe(b.id);
    expect(a.source).toBe('custom');
    expect(a.id).toMatch(/^custom-/);
  });

  it('different headword/pinyin -> different id (no collisions for distinct inputs)', () => {
    const a = buildCustomWord('newword', 'xīnzì');
    const b = buildCustomWord('otherword', 'xīnzì');
    expect(a.id).not.toBe(b.id);
  });

  it('defaults pinyin/gloss/level sensibly when the deck has no such column', () => {
    const w = buildCustomWord('詞');
    expect(w.pinyin).toBe('');
    expect(w.glossEn).toBe('');
    expect(w.level).toBeNull();
    expect(w.chars).toEqual(['詞']);
  });
});
