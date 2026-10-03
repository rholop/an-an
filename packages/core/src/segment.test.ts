import { describe, expect, it } from 'vitest';
import { segment } from './segment.js';
import { buildFixtureLexicon } from './test-fixtures/lexicon-fixture.js';
import { Lexicon } from './lexicon.js';
import type { Word } from './types.js';

const lexicon = buildFixtureLexicon();

function tokenTexts(text: string) {
  return segment(text, lexicon).map((t) => t.text);
}

describe('segment: table-driven Taiwan examples (CLAUDE.md conventions)', () => {
  it('捷運 segments as one word, not 捷+運', () => {
    expect(tokenTexts('捷運')).toEqual(['捷運']);
  });
  it('機車 segments as one word', () => {
    expect(tokenTexts('機車')).toEqual(['機車']);
  });
  it('便利商店 segments as one word, not 便利+商店 or worse', () => {
    expect(tokenTexts('便利商店')).toEqual(['便利商店']);
  });
  it('垃圾車 segments as one word (Taiwan reading lèsèchē)', () => {
    expect(tokenTexts('垃圾車')).toEqual(['垃圾車']);
  });
});

// The 40+ hand-written sentences required by phase doc §"Acceptance
// criteria". Every sentence must segment without throwing, and token spans
// must losslessly reconstruct the input (no dropped/duplicated characters).
const SENTENCES: string[] = [
  '我們搭捷運去便利商店。',
  '他還沒還我錢。',
  '這條路很長。',
  '他是我們的班長。',
  '我覺得睡覺很重要。',
  '你吃飯了嗎？',
  '陳雅婷是我的老師。',
  '這台機車要150塊。',
  '林志明住在台灣。',
  '小安喜歡喝咖啡。',
  '我在夜市買東西。',
  '你可以跟我說中文嗎？',
  '這件事情我做不了。',
  '他的中文說得很好。',
  '我得走了。',
  '你今天看起來很高興。',
  '這家便利商店很大。',
  '我妹妹比我長三歲。',
  '校長今天沒有來上班。',
  '銀行九點才開門。',
  '這樣做可行嗎？',
  '我們一行五個人。',
  '這個包包很重。',
  '老師說這個字要重寫。',
  '音樂會晚上七點開始。',
  '他每天都過得很快樂。',
  '我覺得這部電影很無聊。',
  '你的手機掉在地上了。',
  '悠遊卡可以在捷運和便利商店使用。',
  '他還在等公車。',
  '請問洗手間在哪裡？',
  '我想學中文。',
  '他把作業寫完了。',
  '我昨天去了夜市。',
  '這杯咖啡多少錢？',
  '她說她明天不來。',
  '我們約晚上八點見面。',
  '這隻貓每天都在睡覺。',
  'Hello，你好嗎？',
  '他打電話給我。',
  '這台電腦是我爸爸買的。',
  '我沒有看到你的訊息。',
];

it('has at least 40 test sentences', () => {
  expect(SENTENCES.length).toBeGreaterThanOrEqual(40);
});

describe.each(SENTENCES)('segment("%s")', (sentence) => {
  it('does not throw and losslessly reconstructs the input', () => {
    const tokens = segment(sentence, lexicon);
    expect(tokens.map((t) => t.text).join('')).toBe(sentence);
    expect(tokens.every((t) => t.text.length > 0)).toBe(true);
    // spans must be contiguous and non-overlapping
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.start).toBe(tokens[i - 1]!.end);
    }
  });
});

describe('segment: specific token boundaries for the required examples', () => {
  it('我們搭捷運去便利商店。', () => {
    expect(tokenTexts('我們搭捷運去便利商店。')).toEqual([
      '我們', '搭', '捷運', '去', '便利商店', '。',
    ]);
  });

  it('他還沒還我錢。 (two different 還 readings, disambiguated downstream by resolveReading)', () => {
    expect(tokenTexts('他還沒還我錢。')).toEqual(['他', '還', '沒', '還', '我', '錢', '。']);
  });

  it('這條路很長。', () => {
    expect(tokenTexts('這條路很長。')).toEqual(['這', '條', '路', '很', '長', '。']);
  });

  it('他是我們的班長。 (長 absorbed into the 班長 phrase, not a standalone heteronym)', () => {
    expect(tokenTexts('他是我們的班長。')).toEqual(['他', '是', '我們', '的', '班長', '。']);
  });

  it('我覺得睡覺很重要。 (覺得/睡覺/重要 are each single lexicon words)', () => {
    expect(tokenTexts('我覺得睡覺很重要。')).toEqual(['我', '覺得', '睡覺', '很', '重要', '。']);
  });

  it('你吃飯了嗎？', () => {
    expect(tokenTexts('你吃飯了嗎？')).toEqual(['你', '吃', '飯', '了', '嗎', '？']);
  });

  it('NPC names stay whole words', () => {
    expect(tokenTexts('陳雅婷是我的老師。')).toEqual(['陳雅婷', '是', '我', '的', '老師', '。']);
    expect(tokenTexts('林志明住在台灣。')).toEqual(['林志明', '住', '在', '台灣', '。']);
  });

  it('150塊: digits pass through as a single number token', () => {
    const tokens = segment('這台機車要150塊。', lexicon);
    expect(tokens.map((t) => [t.text, t.kind])).toEqual([
      ['這', 'word'], ['台', 'word'], ['機車', 'word'], ['要', 'word'],
      ['150', 'number'], ['塊', 'word'], ['。', 'punct'],
    ]);
  });

  it('Latin text passes through as its own token kind', () => {
    const tokens = segment('Hello，你好嗎？', lexicon);
    expect(tokens[0]).toMatchObject({ text: 'Hello', kind: 'latin' });
  });
});

describe('segment: hint reconciliation', () => {
  it('keeps a hint span that is a valid lexicon entry', () => {
    // Without the hint, BiMM would still find 便利商店 as one token anyway,
    // so use a span that is ambiguous on its own: 老師 could in principle be
    // forced as a hint even though the default segmentation already agrees;
    // assert that supplying a matching hint doesn't break anything.
    const tokens = segment('他是我們的班長。', lexicon, {
      hints: [{ start: 5, end: 7 }], // "班長"
    });
    expect(tokens.map((t) => t.text)).toEqual(['他', '是', '我們', '的', '班長', '。']);
  });

  it('rejects a hint span that is not in the lexicon or whitelist, re-segmenting it instead', () => {
    const text = '他是我們的班長。';
    const bogusStart = text.indexOf('班');
    const tokens = segment(text, lexicon, {
      hints: [{ start: bogusStart, end: bogusStart + 2 }], // "班長" is actually valid...
    });
    // sanity: this hint is valid and accepted
    expect(tokens.some((t) => t.text === '班長')).toBe(true);

    // Now an invalid hint spanning across a word boundary that doesn't exist
    // in the lexicon ("是我" is not a word) must be rejected and re-segmented.
    const badTokens = segment(text, lexicon, {
      hints: [{ start: 1, end: 3 }], // "是我" — not a lexicon entry
    });
    expect(badTokens.some((t) => t.text === '是我')).toBe(false);
    expect(badTokens.map((t) => t.text).join('')).toBe(text);
  });

  it('accepts a non-lexicon hint span if explicitly whitelisted', () => {
    const text = '這個包包很重。';
    const tokens = segment(text, lexicon, {
      hints: [{ start: 0, end: 2 }], // "這個" — not a fixture lexicon entry
      whitelist: new Set(['這個']),
    });
    expect(tokens.some((t) => t.text === '這個')).toBe(true);
  });
});

describe('segment: compounds missing from TOCFL', () => {
  const mk = (headword: string, pinyin: string, level: Word['level']): Word => ({
    id: `t-${headword}`, headword, variants: [], pos: [], level, source: level ? 'tocfl' : 'supplement',
    pinyin, pinyinNumeric: '', zhuyin: '', glossEn: headword, chars: [...headword], tags: [],
  });
  const lex = new Lexicon([mk('路', 'lù', 'N2'), mk('上', 'shàng', 'L2'), mk('路上', 'lù shàng', null)]);

  it('keeps 路上 as one token when the compound is in the lexicon', () => {
    expect(segment('在路上', new Lexicon([...lex.allWords(), mk('在', 'zài', 'N1')])).map((t) => t.text)).toEqual(['在', '路上']);
  });

  it('splits it only when the compound is absent (the old bug)', () => {
    const without = new Lexicon(lex.allWords().filter((w) => w.headword !== '路上'));
    expect(segment('路上', without).map((t) => t.text)).toEqual(['路', '上']);
  });
});
