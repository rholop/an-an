/**
 * The 34 grammar points of 來學華語 第一冊, TRANSCRIBED BY HAND from the
 * book's 語法 pages (the headings don't extract cleanly — see import report).
 * Patterns follow the book; `explanationEn` is written for this app, not
 * copied. `matcher` is a regex used to tag which of our sentences exercise
 * the point (heuristic; sentences are also generated per point).
 */
export interface BookGrammarPoint {
  id: string;
  lesson: number;
  /** The book's own numbering inside the lesson (1-based). */
  n: number;
  pattern: string;
  explanationEn: string;
  /** Source regex (string) matching Chinese sentences that use the pattern. */
  matcher: string;
  pdfPage: number;
  /**
   * Function words the point itself introduces (not in the 生詞 lists). An object gives the meaning
   * this lesson teaches when the lexicon's own gloss is another sense (分 = minute, not cent).
   */
  words?: Array<string | { headword: string; glossEn: string; id?: string }>;
  /** Function words that signal the pattern (blanked by the grammar cloze). Empty: reorder only. */
  focus: string[];
}

export const LAIXUE1_GRAMMAR: BookGrammarPoint[] = [
  // Lesson 1
  {
    id: 'gram-xing-jiao',
    focus: ['姓', '叫'],
    lesson: 1,
    n: 1,
    pdfPage: 16,
    pattern: 'S + 姓 + surname；S + 叫 + name',
    explanationEn:
      '姓 is followed by a family name only. 叫 is followed by a given name or a full name. Use 姓 for "my surname is…" and 叫 for "I am called…".',
    matcher: '姓|叫',
  },
  {
    id: 'gram-shi-identity',
    focus: ['是'],
    lesson: 1,
    n: 2,
    pdfPage: 18,
    pattern: 'S + 是 + name / nationality',
    explanationEn:
      '是 links a person to a name or a nationality: 我是臺灣人. Nothing like "to be" is needed with 姓 or 叫, but 是 works with names and nationalities.',
    matcher: '是',
  },
  {
    id: 'gram-shenme-question',
    focus: ['什麼'],
    lesson: 1,
    n: 3,
    pdfPage: 19,
    pattern: 'S + V + 什麼(名字)？',
    explanationEn:
      'A question word takes the place of the answer and the word order does not change: 你叫什麼名字？ (compare 我叫明文).',
    matcher: '什麼',
  },
  // Lesson 2
  {
    id: 'gram-you-meiyou',
    focus: ['沒有', '有'],
    lesson: 2,
    n: 1,
    pdfPage: 28,
    pattern: 'S + 有 / 沒有 + O',
    explanationEn:
      '有 means "to have" (or "there is"). Its negative is 沒有 (never 不有): 我沒有弟弟.',
    matcher: '沒有|有',
  },
  {
    id: 'gram-ma-question',
    focus: ['嗎'],
    lesson: 2,
    n: 2,
    pdfPage: 30,
    pattern: 'statement + 嗎？',
    explanationEn:
      'Add 嗎 to the end of a statement to turn it into a yes/no question: 你有弟弟嗎？',
    matcher: '嗎',
  },
  {
    id: 'gram-number-measure',
    focus: ['個', '雙'],
    lesson: 2,
    n: 3,
    pdfPage: 31,
    pattern: 'Numeral + 個 + N',
    explanationEn:
      'Counting people or things needs a measure word between the number and the noun. 個 is the general one: 一個弟弟. For two, use 兩個, not 二個.',
    matcher: '[一兩二三四五六七八九十][個雙位杯家]',
  },
  {
    id: 'gram-ye-also',
    focus: ['也'],
    lesson: 2,
    n: 4,
    pdfPage: 32,
    pattern: 'S + 也 + V + O',
    explanationEn:
      '也 means "also/too" and goes right before the verb, after the subject: 我也是臺灣人.',
    matcher: '也',
  },
  // Lesson 3
  {
    id: 'gram-bu-negation',
    focus: ['不'],
    lesson: 3,
    n: 1,
    pdfPage: 40,
    pattern: 'S + 不 + V',
    explanationEn:
      '不 goes in front of a verb to make it negative: 我不是學生. It is read bú before a 4th-tone syllable and bù otherwise.',
    matcher: '不',
  },
  {
    id: 'gram-zai-place',
    focus: ['在'],
    lesson: 3,
    n: 2,
    pdfPage: 42,
    pattern: 'S + 在 + place + V (O)',
    explanationEn:
      'The place where something happens goes before the verb, introduced by 在: 我在銀行工作. This is the opposite of English word order.',
    matcher: '在.+(工作|念書|教|住|看|吃|打|跑)',
  },
  {
    id: 'gram-dou-all',
    focus: ['都'],
    lesson: 3,
    n: 3,
    pdfPage: 43,
    pattern: 'N (plural) + 都 + (不) + V',
    explanationEn:
      '都 means "both/all" and sits before the verb, referring back to people or things already mentioned. 都不 means "none of them": 他們都不是學生.',
    matcher: '都',
  },
  // Lesson 4
  {
    id: 'gram-a-not-a',
    focus: [],
    lesson: 4,
    n: 1,
    pdfPage: 56,
    pattern: 'S + V 不 V (O)？ / S + 有沒有 + O？',
    explanationEn:
      "Repeat the verb with 不 between to ask a yes/no question: 你忙不忙？ With 有 the negative is 沒有: 你有沒有哥哥？ Don't add 嗎 as well.",
    matcher: '(.)不\\1|(..)不\\2|有沒有',
  },
  {
    id: 'gram-ne-followup',
    focus: ['呢'],
    words: ['呢'],
    lesson: 4,
    n: 2,
    pdfPage: 59,
    pattern: 'S1 + V + N，S2 + 呢？',
    explanationEn:
      '呢 after a noun or pronoun means "and what about…?", returning a question you were just asked: 我叫小文，您呢？',
    matcher: '呢',
  },
  {
    id: 'gram-de-possessive',
    focus: ['的'],
    words: ['的'],
    lesson: 4,
    n: 3,
    pdfPage: 61,
    pattern: 'N / Pron + 的 + N',
    explanationEn:
      '的 links an owner to what is owned: 我的電腦. It is usually left out with close family: 我媽媽, 我爸爸.',
    matcher: '的',
  },
  // Lesson 5
  {
    id: 'gram-zhe-shi-intro',
    focus: ['這是'],
    lesson: 5,
    n: 1,
    pdfPage: 72,
    pattern: '這是 + relationship (+ name)',
    explanationEn:
      'The usual way to introduce someone: 這是我弟弟, then optionally their name: 這是我弟弟，王家文.',
    matcher: '這是|這位是',
  },
  {
    id: 'gram-zhuzai',
    focus: ['住在'],
    lesson: 5,
    n: 2,
    pdfPage: 74,
    pattern: 'S + 住在 + place',
    explanationEn: '住在 means "live in/at" and takes the place straight after it: 他住在臺灣.',
    matcher: '住在',
  },
  {
    id: 'gram-question-words',
    focus: ['誰', '哪裡', '什麼'],
    lesson: 5,
    n: 3,
    pdfPage: 76,
    pattern: 'Question word in place of the answer (什麼 / 哪裡 / 誰)',
    explanationEn:
      '誰, 什麼 and 哪裡 stand where the answer would go, with no change in word order: 他在哪裡工作？ 誰住在臺北？',
    matcher: '誰|哪裡|什麼',
  },
  {
    id: 'gram-qu-place-verb',
    focus: ['去'],
    lesson: 5,
    n: 4,
    pdfPage: 77,
    pattern: 'S + (想) + 去 + place + V',
    explanationEn:
      '去 + place says where you go, and a second verb says what for. 想 ("would like to") goes before 去: 我想去法國念書.',
    matcher: '去.{0,12}(玩|念書|工作|看|吃|買|跑)',
  },
  // Lesson 6
  {
    id: 'gram-hai-also',
    focus: ['還'],
    lesson: 6,
    n: 1,
    pdfPage: 88,
    pattern: 'S + V1 + O1，還 + V2 + O2',
    explanationEn:
      '還 adds a further action or item to what you just said ("also, in addition"): 我喜歡唱歌，還喜歡跳舞. It differs from 也, which adds another subject.',
    matcher: '還',
  },
  {
    id: 'gram-time-place-order',
    focus: ['在'],
    lesson: 6,
    n: 2,
    pdfPage: 90,
    pattern: 'S + time + 在 + place + V (O)',
    explanationEn: 'Chinese order: who, when, where, then what: 我晚上在家看電視.',
    matcher: '(晚上|週末|每天|下午|平常|現在).*在.+(看|吃|跑|念|做|運動|打|聽|唱|跳|玩|工作|教|住)',
  },
  {
    id: 'gram-ye-dou-order',
    focus: ['也', '都'],
    lesson: 6,
    n: 3,
    pdfPage: 91,
    pattern: 'S + 也 / 都 + (不 / 沒) + V',
    explanationEn:
      '也 and 都 come before the negative: 我們都沒有弟弟 ("none of us has…"). When used together the order is 也都: 他們也都有弟弟.',
    matcher: '也都|都不|都沒|也不|也沒',
  },
  // Lesson 7
  {
    id: 'gram-numbers-0-100',
    focus: [],
    lesson: 7,
    n: 1,
    pdfPage: 105,
    pattern: 'Numbers 0–100；兩 + measure word',
    explanationEn:
      'Numbers 11–99 are built from 十: 十二, 二十, 二十五. Use 兩 for "two" of something (兩個學生) and 二 when counting or in numbers.',
    matcher: '[零一二三四五六七八九十百兩]|幾號',
  },
  {
    id: 'gram-gei-call',
    focus: ['給'],
    lesson: 7,
    n: 2,
    pdfPage: 107,
    pattern: 'S + 給 + someone + 打電話',
    explanationEn:
      '給 marks who receives the call and goes before the verb: 我給你打電話. The person called comes before 打電話.',
    matcher: '給.*打電話',
  },
  {
    id: 'gram-yihou',
    focus: ['以後'],
    lesson: 7,
    n: 3,
    pdfPage: 108,
    pattern: 'event 1 + 以後 + event 2',
    explanationEn:
      '以後 after the first event means "after that…": 下課以後，我去吃飯. The earlier event comes first, as in English.',
    matcher: '以後',
  },
  // Lesson 8
  {
    id: 'gram-dates',
    focus: ['月', '號'],
    lesson: 8,
    n: 1,
    pdfPage: 121,
    pattern: 'month 月 + day 號 / 日',
    explanationEn:
      'Months are number + 月 (八月); days are number + 號 (十一號), or 日 in writing. Order is month first, then day.',
    matcher: '[一二三四五六七八九十]+月|[一二三四五六七八九十]+[號日]',
  },
  {
    id: 'gram-ji-questions',
    focus: ['幾'],
    words: ['幾', '日'],
    lesson: 8,
    n: 2,
    pdfPage: 123,
    pattern: '幾月幾號？ / 幾歲？',
    explanationEn:
      '幾 asks for a number: 今天幾月幾號？ asks the date, 你幾歲？ asks the age. Answer by putting the number where 幾 was.',
    matcher: '幾月|幾號|幾歲',
  },
  {
    id: 'gram-tag-question',
    focus: ['好不好', '可以嗎', '好嗎'],
    words: ['可以'],
    lesson: 8,
    n: 3,
    pdfPage: 125,
    pattern: '…，好不好？ / …，可以嗎？',
    explanationEn:
      'Put 好不好 or 好嗎 after a suggestion to ask "is that OK?", and 可以嗎 to ask for permission: 我們去吃大餐，好不好？',
    matcher: '好不好|好嗎|可以嗎|可以不可以',
  },
  // Lesson 9
  {
    id: 'gram-xingqi',
    focus: ['星期'],
    words: ['星期', '星期一', '星期二', '星期三', '星期四', '星期天', '星期日', '禮拜', '週'],
    lesson: 9,
    n: 1,
    pdfPage: 137,
    pattern: '星期 + number',
    explanationEn:
      'Weekdays are 星期 + number, Monday = 一. Sunday is 星期天 or 星期日, never 星期七. 禮拜 means the same as 星期. Ask with 星期幾？',
    matcher: '星期|禮拜',
  },
  {
    id: 'gram-year-date',
    focus: ['年'],
    lesson: 9,
    n: 2,
    pdfPage: 139,
    pattern: 'year 年 + month 月 + day 號',
    explanationEn:
      'Dates run from big to small: year, month, day. Years are read digit by digit: 二〇二五年.',
    matcher: '年.*月',
  },
  {
    id: 'gram-dian-clock',
    focus: ['點'],
    words: [{ headword: '分', glossEn: 'minute (telling the time)' }, '點鐘'],
    lesson: 9,
    n: 3,
    pdfPage: 141,
    pattern: 'hour 點 + minute 分 / 半',
    explanationEn:
      "Time is number + 點 (o'clock), then minutes + 分, or 半 for half past: 六點半. 分 can be dropped after the number.",
    matcher: '[一二兩三四五六七八九十]+點|幾點',
  },
  {
    id: 'gram-gen-yiqi',
    focus: ['跟'],
    lesson: 9,
    n: 4,
    pdfPage: 143,
    pattern: 'S + 跟 + someone + 一起 + V (O)',
    explanationEn:
      '跟…一起 means "together with…" and goes before the main verb: 我跟朋友一起吃飯.',
    matcher: '跟.+一起',
  },
  // Lesson 10
  {
    id: 'gram-de-complement',
    focus: ['得'],
    lesson: 10,
    n: 1,
    pdfPage: 155,
    pattern: 'S + V (+ O)，V + 得 + (Adv) + Vs',
    explanationEn:
      '得 after a verb introduces how well or how the action is done: 他說得很好. If the verb has an object, repeat the verb: 他說中文，說得很好.',
    matcher: '.得(很|不|好|怎麼樣|不錯|快)',
  },
  {
    id: 'gram-youyidian',
    focus: ['有一點', '有點'],
    words: ['有點'],
    lesson: 10,
    n: 2,
    pdfPage: 156,
    pattern: '有一點 + state verb',
    explanationEn:
      '有一點 (or 有點) means "a little" and is for unwelcome things: 有一點累, 有點難. It is not used with positive ones such as 好吃.',
    matcher: '有一?點[累難忙貴快]',
  },
  {
    id: 'gram-hui-can',
    focus: ['會'],
    lesson: 10,
    n: 3,
    pdfPage: 158,
    pattern: 'S + 會 / 不會 + V (O)',
    explanationEn: '會 means "know how to" for a learned skill: 我會說中文. The negative is 不會.',
    matcher: '會',
  },
  {
    id: 'gram-duoshao-ji',
    focus: ['多少', '幾'],
    lesson: 10,
    n: 4,
    pdfPage: 159,
    pattern: 'S + V + 多少 / 幾 + (measure word) + N？',
    explanationEn:
      '多少 asks about any quantity (the measure word is optional); 幾 is for small numbers (up to about ten). Before a noun 幾 takes a measure word (你有幾個孩子？); with words that are units themselves it does not (幾月幾號, 幾歲, 幾點).',
    matcher: '多少|幾[個位杯家]',
  },
];
