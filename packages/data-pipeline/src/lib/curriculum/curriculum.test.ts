import { describe, expect, it } from 'vitest';
import { Lexicon, type Word } from '@anan/core';
import { countPinyinSyllables, dedupeRuby, splitVariants } from './clean.js';
import { parseDialogue, parseExamples } from './dialogue-parse.js';
import { LAIXUE1_GRAMMAR } from './grammar-points.js';
import { linkBookWord, linkVariantForms, pinyinOptions, tonelessPinyin } from './link.js';
import { parseLessonFront, parseToc } from './objectives.js';
import { entryToWord, parseVocabBlock } from './vocab-parse.js';
import { parseVocabIndex } from './index-parse.js';
import { draftPlan, parsePlan } from './lesson-plan.js';

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


describe('series layouts (books 2–4)', () => {
  const furniture = { titleZh: '今天天氣很好', titleEn: 'The Weather Is Nice Today' };
  const entry = (n: number, head: string, py: string, extra: string[]) => [`${n}.`, head, py, ...extra];

  it('book 2 running header (page no. / Lesson / title / 01) is dropped', () => {
    const page = ['002', 'Lesson', '今天天氣很好', '01', ...entry(11, '冬天', 'dōngtiān', ['N', 'winter'])].join('\n');
    const raw = parseVocabBlock([page], furniture, { sections: 'order' });
    expect(raw).toHaveLength(1);
    expect(raw[0]!.lines.join('|')).not.toContain('Lesson');
  });

  it('books 3–4 header "Lesson01 <title>" and the odd-page English title are dropped', () => {
    const p1 = ['004', 'Lesson01 我要到臺灣去', ...entry(1, '午安', 'wǔān', ['V', 'Good afternoon'])].join('\n');
    const p2 = ['005', 'The Weather Is Nice Today', ...entry(2, '遲到', 'chídào', ['V', 'arrive late'])].join('\n');
    const raw = parseVocabBlock([p1, p2], furniture, { sections: 'order' });
    expect(raw.map((e) => e.n)).toEqual([1, 2]);
    expect(raw.flatMap((e) => e.lines).join('|')).not.toMatch(/Lesson|Weather/);
  });

  it("'order' mode sections: POS → core, no POS → phrase / proper (capitalised), POS afterwards → supplementary", () => {
    const text = [
      ...entry(1, '天氣', 'tiānqì', ['N', 'weather']),
      ...entry(2, '太……了', 'tài…le', ['too, so']),
      ...entry(3, '下雪', 'xià xuě', ['to snow']),
      ...entry(4, '林', 'Lín', ['an example of a surname']),
      ...entry(5, '昨天', 'zuótiān', ['N', 'yesterday']),
      '短語Phrases', // headings are not trusted in this mode
    ].join('\n');
    const raw = parseVocabBlock([text], furniture, { sections: 'order' });
    expect(raw.map((e) => e.section)).toEqual(['core', 'phrase', 'phrase', 'proper', 'supplementary']);
  });

  it('a part of speech glued to the reading line ("chāojí shìchǎng N") still makes the entry core', () => {
    const text = [
      ...entry(1, '離', 'lí', ['Prep', 'away from']),
      '2.', '超級市場', 'chāojí shìchǎng N', 'supermarket',
      ...entry(3, '搬家', 'bān jiā', ['to move (home)']),
    ].join('\n');
    const raw = parseVocabBlock([text], furniture, { sections: 'order' });
    const w = raw.map((e) => entryToWord(2, e));
    expect(w[1]).toMatchObject({ headword: '超級市場', pinyin: 'chāojí shìchǎng', pos: ['N'], glossEn: 'supermarket' });
    expect(raw.map((e) => e.section)).toEqual(['core', 'core', 'phrase']);
  });

  it('headword + reading glued, a wrapped headword, and gloss pollution from the next lines', () => {
    const glued = entryToWord(4, {
      n: 24,
      section: 'phrase',
      lines: ['雞肉三明治jīròu sānmíngzhì (chicken sandwich)'],
    });
    expect(glued).toMatchObject({ headword: '雞肉三明治', pinyin: 'jīròu sānmíngzhì', glossEn: 'chicken sandwich' });
    const wrapped = entryToWord(5, {
      n: 23,
      section: 'core',
      lines: ['東方美人', '茶', 'dōngfāng', 'měirénchá', 'N', 'oolong tea'],
    });
    expect(wrapped).toMatchObject({ headword: '東方美人茶', pinyin: 'dōngfāng měirénchá', pos: ['N'] });
    const polluted = entryToWord(9, {
      n: 8,
      section: 'core',
      lines: ['畫', 'huà', 'N', 'painting', '好啊！上午去附近的小山玩玩。', 'Hǎo a! Shàngwǔ qù fùjìn'],
    });
    expect(polluted.glossEn).toBe('painting');
  });

  it('keeps an English gloss with an accent ("Tasty Café")', () => {
    const w = entryToWord(9, { n: 23, section: 'proper', lines: ['美味餐廳', 'Měiwèi Cāntīng', 'Tasty Café'] });
    expect(w.glossEn).toBe('Tasty Café');
  });

  it('a pattern entry that begins with …… is still an entry', () => {
    const text = [...entry(25, '天氣預報', 'tiānqì yùbào', ['weather forecast']), ...entry(26, '……的時候', '…de shíhòu', ['when…'])].join('\n');
    const raw = parseVocabBlock([text], furniture, { sections: 'order' });
    expect(raw.map((e) => e.n)).toEqual([25, 26]);
    expect(raw[0]!.lines.join(' ')).not.toContain('時候');
  });

  it('dialogue: a speaker written with an ideographic space (杜　翔：) and narrative-only texts', () => {
    const d = parseDialogue('1. Read aloud\n杜　翔：我們公司最忙。\n高莉亞：你好辛苦啊！\n綜合活動');
    expect(d.lines.map((l) => l.speaker)).toEqual(['杜翔', '高莉亞']);
    const n = parseDialogue('1. Read aloud\n　　高莉亞在公司工作，公司有三十個人。\n她有幾個同事。\n　　早上六點起床。\n2. Fill in the Blanks');
    expect(n.lines).toHaveLength(2);
    expect(n.lines[0]).toMatchObject({ speaker: '' });
  });

  it('examples: a worked example without pinyin keeps its English line', () => {
    const ex = parseExamples('(1) 你有空的話，我們去吃飯。\nIf you have time, let us eat.\n(2) 他不來。\nTā bù lái.\nHe is not coming.');
    expect(ex[0]).toMatchObject({ pinyin: '', en: 'If you have time, let us eat.' });
    expect(ex[1]).toMatchObject({ pinyin: 'Tā bù lái.', en: 'He is not coming.' });
  });

  it('objectives pages that open "By the end of this lesson" (books 3–4)', () => {
    const f = parseLessonFront('By the end of this lesson, you will be able to use Mandarin to\n1. Ask others.\n2. Describe things.\nLearning Objectives\nTopic: Weather');
    expect(f.objectives).toEqual(['Ask others.', 'Describe things.']);
    expect(f.topic).toBe('Weather');
  });
});

describe('appendix vocabulary index', () => {
  it('reads pinyin, headword and the lesson-n locator, ignoring headings and letter dividers', () => {
    const page = ['162', 'Vocabulary Index', '生詞', '索引', 'a', '啊', '啊', '[exclamatory particle]', '1-9', 'B', 'bǐ', '比', '比', 'comparison marker, (more) than', '1-6', 'sentence-final particle for suggestion 10-9'].join('\n');
    const e = parseVocabIndex([page]);
    expect(e.map((x) => `${x.lesson}-${x.n}:${x.headword}`)).toEqual(['1-9:啊', '1-6:比', '10-9:']);
  });
});

describe('lesson plan', () => {
  const book = {
    id: 'laixue-2',
    titleZh: '來學華語 第二冊',
    titleEn: "Let's Learn Mandarin 2",
    lessons: [
      { id: 'laixue-2-L01', n: 1, titleZh: '', titleEn: 'The Weather Is Nice Today', topic: 'Weather', objectives: ['List the four seasons', 'Discuss the forecast', 'Compare places'] },
    ],
  } as never;

  it('the draft parses back into scenarios with NPCs and three prompts, and the edited file is the source of truth', () => {
    const md = draftPlan(book, () => 'L1');
    const plan = parsePlan(md);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.scenarios.length).toBe(2);
    expect(plan[0]!.scenarios[0]).toMatchObject({ npcId: 'mingwen' });
    expect(plan[0]!.prompts).toHaveLength(3);
    const edited = md.replace('NPC: mingwen —', 'NPC: waiter —');
    expect(parsePlan(edited)[0]!.scenarios[0]!.npcId).toBe('waiter');
  });
});
