import { describe, expect, it } from 'vitest';
import { Lexicon, type Word } from '@anan/core';
import { countPinyinSyllables, dedupeRuby, splitVariants } from './clean.js';
import { parseDialogue, parseExamples } from './dialogue-parse.js';
import { LAIXUE1_GRAMMAR } from './grammar-points.js';
import { linkBookWord, linkVariantForms, pinyinOptions, tonelessPinyin } from './link.js';
import { parseLessonFront, parseToc } from './objectives.js';
import { entryToWord, parseVocabBlock } from './vocab-parse.js';

describe('cleaning extracted headwords (fixtures for the PDF quirks)', () => {
  it('ruby duplicate: 名字子 → 名字', () => {
    expect(dedupeRuby('名字子', countPinyinSyllables('míngzi'))).toBe('名字');
    expect(dedupeRuby('喂為', countPinyinSyllables('wéi'))).toBe('喂');
  });
  it('leaves a correct headword alone, including 3-syllable words', () => {
    expect(dedupeRuby('名字', 2)).toBe('名字');
    expect(dedupeRuby('小孩子', countPinyinSyllables('xiǎo háizi'))).toBe('小孩子');
    expect(dedupeRuby('便利商店', countPinyinSyllables('biànlì shāngdiàn'))).toBe('便利商店');
  });
  it('variants: 臺灣/ 台灣 → both forms, primary first', () => {
    expect(splitVariants('臺灣/ 台灣')).toEqual(['臺灣', '台灣']);
    expect(splitVariants('臺北 / 台北')).toEqual(['臺北', '台北']);
  });
  it('tone variants: 一/ 一/ 一 collapse to one form', () => {
    expect(splitVariants('一/ 一/ 一')).toEqual(['一']);
    expect(splitVariants('不/ 不')).toEqual(['不']);
  });
  it('bracketed alternates and trailing punctuation', () => {
    expect(splitVariants('哪裡（哪兒）')).toEqual(['哪裡', '哪兒']);
    expect(splitVariants('貴姓？')).toEqual(['貴姓']);
    expect(splitVariants('兄弟姊（姐）妹')).toEqual(['兄弟姊妹', '兄弟姐妹']);
  });
  it('pinyin syllable counts', () => {
    expect(countPinyinSyllables('nǚ’ér')).toBe(2);
    expect(countPinyinSyllables('Táiwān rén')).toBe(3);
    expect(countPinyinSyllables('xiōngdì jiěmèi')).toBe(4);
  });
});

describe('parseVocabBlock', () => {
  // Synthetic page text in the shape PyMuPDF emits: numbered entries, headings AFTER
  // their group and in a jumbled order, numbers glued to the headword after 9.
  const furniture = { titleZh: '測試', titleEn: 'A Test' };
  const page1 = [
    '1.',
    '名字子',
    'míngzi',
    'N',
    'name',
    '2.',
    '臺灣/ 台灣',
    'Táiwān',
    'N',
    'Taiwan',
    '3.',
    '一/ 一/ 一',
    'yī / yí / yì',
    'Num',
    'one',
    '生詞Vocabulary',
  ].join('\n');
  const page2 = [
    'Lesson',
    '004',
    '測試',
    '01',
    '7.',
    '平常',
    'píngcháng',
    'Adv',
    'usually',
    '4.',
    '請問',
    'qǐng wèn',
    'May I ask',
    '5.',
    '好久不見',
    'hǎojiǔ bújiàn',
    'long time no see',
    '短語Phrases',
    '6.',
    '王明文',
    'Wáng Míngwén',
    'an example of a name',
    '專有名詞Proper Nouns',
    '補充生詞Supplementary Vocabulary',
  ].join('\n');

  it('parses entries, cleans headwords and assigns sections', () => {
    const raw = parseVocabBlock([page1, page2], furniture);
    const words = raw.map((e) => entryToWord(1, e));
    const byN = Object.fromEntries(words.map((w) => [w.n, w]));
    expect(byN[1]).toMatchObject({
      headword: '名字',
      pinyin: 'míngzi',
      pos: ['N'],
      section: 'core',
    });
    expect(byN[2]).toMatchObject({ headword: '臺灣', variants: ['台灣'] });
    expect(byN[3]).toMatchObject({ headword: '一', variants: [], pos: ['Num'] });
    expect(byN[5]).toMatchObject({ headword: '好久不見', section: 'phrase', pos: [] });
    expect(byN[6]).toMatchObject({ headword: '王明文', section: 'proper' });
  });

  it('a block whose heading printed on an earlier page inherits its section', () => {
    // 7 follows 4–5(phrase)… but is out of sequence in the stream: it joins the nearest lower labelled block.
    const raw = parseVocabBlock([page1, page2], furniture);
    expect(raw.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('drops the page furniture (running header) instead of folding it into a gloss', () => {
    const raw = parseVocabBlock([page1, page2], furniture);
    const all = raw.flatMap((e) => e.lines).join('|');
    expect(all).not.toContain('Lesson');
    expect(all).not.toContain('004');
  });
});

describe('parseDialogue', () => {
  const text = [
    '1.\tRead aloud',
    'Lisa',
    '：Gloria，休息一下。',
    'Gloria ：我今天很忙，現在要休息一下，然後',
    '再去喝咖啡。',
    '（休息室xiūxí shì）',
    '2.\tFill in the Blanks',
    'A：不要這個',
  ].join('\n');
  it('rejoins a speaker split from its line, joins wrapped lines, drops stage directions', () => {
    const { lines, dropped } = parseDialogue(text);
    expect(lines).toEqual([
      { speaker: 'Lisa', zh: 'Gloria，休息一下。' },
      { speaker: 'Gloria', zh: '我今天很忙，現在要休息一下，然後再去喝咖啡。' },
    ]);
    expect(dropped).toEqual(['（休息室xiūxí shì）']);
  });
});

describe('parseExamples', () => {
  it('reads (n) zh / pinyin / English triplets', () => {
    const ex = parseExamples(
      [
        '(1) 我不是學生。',
        'Wǒ bú shì xuéshēng.',
        'I am not a student.',
        '(2) 他們都是學生。',
        'Tāmen dōu shì xuéshēng.',
        'They are all students.',
      ].join('\n'),
    );
    expect(ex).toEqual([
      { zh: '我不是學生。', pinyin: 'Wǒ bú shì xuéshēng.', en: 'I am not a student.' },
      { zh: '他們都是學生。', pinyin: 'Tāmen dōu shì xuéshēng.', en: 'They are all students.' },
    ]);
  });
});

describe('lesson front matter and contents', () => {
  it('objectives page', () => {
    const f = parseLessonFront(
      [
        '您好',
        'Hello!',
        'Lesson',
        '01',
        'At the end of this lesson, you will be able to use Mandarin to',
        '1.\tGreet others',
        '2.\tTell others your name and',
        'ask the same',
        'Learning Objectives',
        'Topic: Greetings',
      ].join('\n'),
    );
    expect(f).toMatchObject({ titleEn: 'Hello!', topic: 'Greetings' });
    expect(f.objectives).toEqual(['Greet others', 'Tell others your name and ask the same']);
  });
  it('contents page gives full (unwrapped) titles', () => {
    const toc = parseToc(
      [
        '第四課　我爸爸在電腦公司工作',
        'Lesson 4　My Father Works at a Computer Company .........41',
      ].join('\n'),
    );
    expect(toc).toEqual([
      { n: 4, titleZh: '我爸爸在電腦公司工作', titleEn: 'My Father Works at a Computer Company' },
    ]);
  });
});

describe('linking to the lexicon', () => {
  const w = (
    id: string,
    headword: string,
    pinyin: string,
    glossEn: string,
    over: Partial<Word> = {},
  ): Word => ({
    id,
    headword,
    variants: [],
    pos: ['N'],
    level: 'N1',
    source: 'tocfl',
    pinyin,
    pinyinNumeric: '',
    zhuyin: '',
    glossEn,
    chars: [...headword],
    tags: [],
    ...over,
  });
  const lexicon = new Lexicon([
    w('a-1', '還', 'hái', 'still; also'),
    w('a-2', '還', 'huán', 'to return (something)'),
    w('b', '不', 'bù', 'not; no', { pos: ['Adv'] }),
    w('c', '台灣', 'táiwān', 'Taiwan'),
    w('d', '她', 'tā', 'she'),
  ]);
  const bw = (
    headword: string,
    pinyin: string,
    glossEn: string,
    variants: string[] = [],
    pos: string[] = [],
  ) => ({
    lesson: 1,
    n: 1,
    section: 'core' as const,
    headword,
    variants,
    pinyin,
    pos,
    glossEn,
  });

  it('chooses the sense whose reading and gloss match the book', () => {
    expect(linkBookWord(bw('還', 'hái', 'also, in addition'), lexicon).word?.id).toBe('a-1');
    expect(linkBookWord(bw('還', 'huán', 'to return'), lexicon).word?.id).toBe('a-2');
  });
  it('tone sandhi in the book (bú) still links to 不 bù', () => {
    const r = linkBookWord(bw('不', 'bú / bù', 'no, not'), lexicon);
    expect(r.word?.id).toBe('b');
    expect(r.tier).toBe('exact'); // "bù" is one of the book's accepted readings
    expect(pinyinOptions('bú / bù')).toEqual(['bú', 'bù']);
    expect(tonelessPinyin('lǜ')).toBe('lu');
  });
  it('a different reading with no gloss support is NOT linked (becomes a textbook entry)', () => {
    expect(linkBookWord(bw('還', 'xuán', 'whirl'), lexicon).word).toBeUndefined();
  });
  it('a variant written form that is its own entry joins the lesson', () => {
    const primary = lexicon.byId('c')!;
    expect(linkVariantForms(bw('臺灣', 'Táiwān', 'Taiwan', ['台灣']), lexicon, primary)).toEqual(
      [],
    );
    const extra = linkVariantForms(bw('他', 'tā', 'he', ['她']), lexicon, lexicon.byId('b')!);
    expect(extra.map((x) => x.id)).toEqual(['d']);
  });
});

describe('the 34 hand-transcribed grammar points', () => {
  it('there are 34, ids unique, spread over lessons 1–10', () => {
    expect(LAIXUE1_GRAMMAR).toHaveLength(34);
    expect(new Set(LAIXUE1_GRAMMAR.map((g) => g.id)).size).toBe(34);
    const perLesson = new Map<number, number>();
    for (const g of LAIXUE1_GRAMMAR) perLesson.set(g.lesson, (perLesson.get(g.lesson) ?? 0) + 1);
    expect([...perLesson.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...perLesson.values()].every((n) => n >= 3)).toBe(true);
  });
  it('every matcher is a valid regex and every explanation is written for the app', () => {
    for (const g of LAIXUE1_GRAMMAR) {
      expect(() => new RegExp(g.matcher, 'u'), g.id).not.toThrow();
      expect(g.explanationEn.length, g.id).toBeGreaterThan(30);
      expect(g.pattern, g.id).toBeTruthy();
    }
  });
});
