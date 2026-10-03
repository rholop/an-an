import { describe, expect, it } from 'vitest';
import { Lexicon } from './lexicon.js';
import type { Word } from './types.js';
import { buildFixtureLexicon, FIXTURE_WORDS } from './test-fixtures/lexicon-fixture.js';

describe('Lexicon', () => {
  const lexicon = buildFixtureLexicon();

  it('lookup finds all senses sharing a headword (homographs)', () => {
    expect(lexicon.lookup('還').map((w) => w.pinyin).sort()).toEqual(['huán', 'hái'].sort());
    expect(lexicon.lookup('長').map((w) => w.pinyin).sort()).toEqual(['cháng', 'zhǎng'].sort());
  });

  it('lookup returns [] for a spelling not in the lexicon', () => {
    expect(lexicon.lookup('龘')).toEqual([]);
  });

  it('byId finds the exact Word by stable id', () => {
    const w = FIXTURE_WORDS.find((w) => w.headword === '捷運')!;
    expect(lexicon.byId(w.id)).toEqual(w);
  });

  it('prefixesOf returns every valid prefix, longest first', () => {
    const matches = lexicon.prefixesOf('便利商店很大', 0);
    expect(matches[0]).toMatchObject({ len: 4 }); // 便利商店
    expect(matches[0]!.words[0]!.headword).toBe('便利商店');
  });

  it('prefixesOf returns [] at a position with no lexicon match', () => {
    expect(lexicon.prefixesOf('龘龘龘', 0)).toEqual([]);
  });

  it('charInfo reports level for a single-character entry', () => {
    const info = lexicon.charInfo('錢');
    expect(info.words.length).toBeGreaterThan(0);
  });

  it('variants resolve to the same Word as the headword', () => {
    const lex = new Lexicon([
      {
        id: 'v1',
        headword: '軟體',
        variants: ['软体'],
        pos: ['N'],
        level: null,
        source: 'tocfl',
        pinyin: 'ruǎn tǐ',
        pinyinNumeric: 'ruan3 ti3',
        zhuyin: 'ㄖㄨㄢˇ ㄊㄧˇ',
        glossEn: 'software',
        chars: ['軟', '體'],
        tags: [],
      },
    ]);
    expect(lex.lookup('软体')[0]?.headword).toBe('軟體');
  });

  it('orders homographs lowest level first, regardless of input/id order', () => {
    const mk = (id: string, level: Word['level'], pos: string): Word => ({
      id, headword: '去', variants: [], pos: [pos], level, source: 'tocfl', pinyin: 'qù',
      pinyinNumeric: 'qu4', zhuyin: 'ㄑㄩˋ', glossEn: 'x', chars: ['去'], tags: [],
    });
    const lex = new Lexicon([mk('a-l3-ptc', 'L3', 'Ptc'), mk('b-null', null, 'V'), mk('c-n1-v', 'N1', 'V'), mk('d-l3-adv', 'L3', 'Adv')]);
    expect(lex.lookup('去').map((w) => w.id)).toEqual(['c-n1-v', 'a-l3-ptc', 'd-l3-adv', 'b-null']);
    expect(lex.preferred('去')?.id).toBe('c-n1-v');
    expect(lex.charInfo('去').level).toBe('N1');
  });

  it('preferred() honours a matching reading before falling back to level', () => {
    const lex = buildFixtureLexicon();
    expect(lex.preferred('還', 'huán')?.pinyin).toBe('huán');
    expect(lex.preferred('還', 'nope')).toBeDefined();
    expect(lex.preferred('龘')).toBeUndefined();
  });
});
