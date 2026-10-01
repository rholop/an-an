import { Lexicon } from '../lexicon.js';
import { toPinyinNumeric, pinyinToZhuyin } from '../pinyin.js';
import type { Level, Word } from '../types.js';

interface Spec {
  headword: string;
  pinyin: string; // space-separated per syllable, matching MOE convention
  pos?: string[];
  level?: Level | null;
  glossEn: string;
  senseNote?: string;
  variants?: string[];
  tags?: string[];
  source?: Word['source'];
  freqRank?: number;
}

let n = 0;
function word(spec: Spec): Word {
  n += 1;
  return {
    id: `fix-${n}-${spec.headword}`,
    headword: spec.headword,
    variants: spec.variants ?? [],
    pos: spec.pos ?? ['N'],
    level: spec.level ?? null,
    source: spec.source ?? 'tocfl',
    pinyin: spec.pinyin,
    pinyinNumeric: toPinyinNumeric(spec.pinyin),
    zhuyin: pinyinToZhuyin(spec.pinyin),
    glossEn: spec.glossEn,
    senseNote: spec.senseNote,
    chars: [...spec.headword],
    tags: spec.tags ?? [],
    freqRank: spec.freqRank,
  };
}

// Vocabulary covering CLAUDE.md's required Taiwan examples (捷運, 機車,
// 便利商店, 垃圾車, 還/還, 長/長, 了/了) plus the phase-doc's 40+
// hand-written segmenter sentences (see segment.test.ts). Not the real
// lexicon — that's built by packages/data-pipeline from the actual TOCFL +
// MOE sources.
export const FIXTURE_WORDS: Word[] = [
  word({ headword: '我', pinyin: 'wǒ', pos: ['N'], glossEn: 'I; me' }),
  word({ headword: '你', pinyin: 'nǐ', pos: ['N'], glossEn: 'you' }),
  word({ headword: '他', pinyin: 'tā', pos: ['N'], glossEn: 'he; him' }),
  word({ headword: '她', pinyin: 'tā', pos: ['N'], glossEn: 'she; her' }),
  word({ headword: '我們', pinyin: 'wǒ men', pos: ['N'], glossEn: 'we; us' }),
  word({ headword: '搭', pinyin: 'dā', pos: ['V'], glossEn: 'to take (transport)' }),
  word({ headword: '去', pinyin: 'qù', pos: ['V'], glossEn: 'to go' }),
  word({ headword: '是', pinyin: 'shì', pos: ['V'], glossEn: 'to be' }),
  word({ headword: '在', pinyin: 'zài', pos: ['V', 'Prep'], glossEn: 'at; to be located at' }),
  word({ headword: '有', pinyin: 'yǒu', pos: ['V'], glossEn: 'to have' }),
  word({ headword: '沒有', pinyin: 'méi yǒu', pos: ['V'], glossEn: 'to not have; did not' }),
  word({ headword: '吃', pinyin: 'chī', pos: ['V'], glossEn: 'to eat' }),
  word({ headword: '飯', pinyin: 'fàn', pos: ['N'], glossEn: 'cooked rice; meal' }),
  word({ headword: '喝', pinyin: 'hē', pos: ['V'], glossEn: 'to drink' }),
  word({ headword: '睡覺', pinyin: 'shuì jiào', pos: ['Vi'], glossEn: 'to sleep' }),
  word({ headword: '覺得', pinyin: 'jué de', pos: ['V'], glossEn: 'to feel; to think that' }),
  word({ headword: '很', pinyin: 'hěn', pos: ['Adv'], glossEn: 'very' }),
  word({ headword: '重要', pinyin: 'zhòng yào', pos: ['Vs'], glossEn: 'important' }),

  word({ headword: '了', pinyin: 'le', pos: ['Ptc'], glossEn: 'perfective/change-of-state particle', senseNote: 'le' }),
  word({ headword: '了', pinyin: 'liǎo', pos: ['Ptc'], glossEn: 'potential-complement "able to" (可V/不V了)', senseNote: 'liao' }),
  word({ headword: '嗎', pinyin: 'ma', pos: ['Ptc'], glossEn: 'question particle' }),
  word({ headword: '的', pinyin: 'de', pos: ['Ptc'], glossEn: "possessive/attributive particle" }),

  word({ headword: '陳雅婷', pinyin: 'chén yǎ tíng', pos: ['Nb'], glossEn: '(NPC name)', source: 'supplement', tags: ['name', 'npc'] }),
  word({ headword: '林志明', pinyin: 'lín zhì míng', pos: ['Nb'], glossEn: '(NPC name)', source: 'supplement', tags: ['name', 'npc'] }),
  word({ headword: '小安', pinyin: 'xiǎo ān', pos: ['Nb'], glossEn: "(NPC name)", source: 'supplement', tags: ['name', 'npc'] }),
  word({ headword: '老師', pinyin: 'lǎo shī', pos: ['N'], glossEn: 'teacher' }),

  word({ headword: '這', pinyin: 'zhè', pos: ['Det'], glossEn: 'this' }),
  word({ headword: '條', pinyin: 'tiáo', pos: ['Msr'], glossEn: 'classifier (long thin things, roads)' }),
  word({ headword: '路', pinyin: 'lù', pos: ['N'], glossEn: 'road' }),
  word({ headword: '班長', pinyin: 'bān zhǎng', pos: ['N'], glossEn: 'class monitor' }),

  word({ headword: '長', pinyin: 'cháng', pos: ['Vs'], glossEn: 'long', senseNote: 'chang:long' }),
  word({ headword: '長', pinyin: 'zhǎng', pos: ['V', 'N'], glossEn: 'to grow; chief/head', senseNote: 'zhang:chief-grow' }),
  word({ headword: '還', pinyin: 'hái', pos: ['Adv'], glossEn: 'still; yet; also', senseNote: 'hai:still' }),
  word({ headword: '還', pinyin: 'huán', pos: ['V'], glossEn: 'to return (something)', senseNote: 'huan:return' }),
  word({ headword: '重', pinyin: 'zhòng', pos: ['Vs'], glossEn: 'heavy', senseNote: 'zhong:heavy' }),
  word({ headword: '重', pinyin: 'chóng', pos: ['Adv'], glossEn: 'again; re-', senseNote: 'chong:again' }),
  word({ headword: '行', pinyin: 'xíng', pos: ['Vs'], glossEn: 'okay; workable', senseNote: 'xing:okay' }),
  word({ headword: '行', pinyin: 'háng', pos: ['N', 'Msr'], glossEn: 'row; profession; classifier for a line/group', senseNote: 'hang:row' }),
  word({ headword: '得', pinyin: 'de', pos: ['Ptc'], glossEn: 'structural particle (V 得 Adj)', senseNote: 'de:structural' }),
  word({ headword: '得', pinyin: 'děi', pos: ['Aux'], glossEn: 'must; have to', senseNote: 'dei:must' }),
  word({ headword: '樂', pinyin: 'lè', pos: ['Vs'], glossEn: 'happy', senseNote: 'le4:happy' }),
  word({ headword: '樂', pinyin: 'yuè', pos: ['N'], glossEn: 'music', senseNote: 'yue:music' }),

  word({ headword: '錢', pinyin: 'qián', pos: ['N'], glossEn: 'money' }),
  word({ headword: '台', pinyin: 'tái', pos: ['Msr'], glossEn: 'classifier (machines, vehicles)' }),
  word({ headword: '機車', pinyin: 'jī chē', pos: ['N'], glossEn: 'scooter/motorbike', source: 'supplement', tags: ['taiwan-specific'] }),
  word({ headword: '要', pinyin: 'yào', pos: ['V'], glossEn: 'to want; to cost; will' }),
  word({ headword: '塊', pinyin: 'kuài', pos: ['Msr'], glossEn: 'classifier for NT dollars' }),

  word({ headword: '台灣', pinyin: 'tái wān', pos: ['Nb'], glossEn: 'Taiwan' }),
  word({ headword: '住', pinyin: 'zhù', pos: ['V'], glossEn: 'to live/reside' }),
  word({ headword: '喜歡', pinyin: 'xǐ huān', pos: ['V'], glossEn: 'to like' }),
  word({ headword: '咖啡', pinyin: 'kā fēi', pos: ['N'], glossEn: 'coffee' }),
  word({ headword: '夜市', pinyin: 'yè shì', pos: ['N'], glossEn: 'night market', source: 'supplement', tags: ['taiwan-specific'] }),
  word({ headword: '買', pinyin: 'mǎi', pos: ['V'], glossEn: 'to buy' }),
  word({ headword: '東西', pinyin: 'dōng xī', pos: ['N'], glossEn: 'thing(s)' }),

  word({ headword: '可以', pinyin: 'kě yǐ', pos: ['Aux'], glossEn: 'can; may' }),
  word({ headword: '跟', pinyin: 'gēn', pos: ['Prep', 'Conj'], glossEn: 'with; and' }),
  word({ headword: '說', pinyin: 'shuō', pos: ['V'], glossEn: 'to speak/say' }),
  word({ headword: '中文', pinyin: 'zhōng wén', pos: ['N'], glossEn: 'Chinese (language)' }),

  word({ headword: '件', pinyin: 'jiàn', pos: ['Msr'], glossEn: 'classifier (matters, clothing)' }),
  word({ headword: '事情', pinyin: 'shì qíng', pos: ['N'], glossEn: 'matter; affair' }),
  word({ headword: '做', pinyin: 'zuò', pos: ['V'], glossEn: 'to do; to make' }),
  word({ headword: '不', pinyin: 'bù', pos: ['Adv'], glossEn: 'not' }),

  word({ headword: '走', pinyin: 'zǒu', pos: ['V'], glossEn: 'to walk; to leave' }),
  word({ headword: '今天', pinyin: 'jīn tiān', pos: ['N'], glossEn: 'today' }),
  word({ headword: '看', pinyin: 'kàn', pos: ['V'], glossEn: 'to look/watch/read' }),
  word({ headword: '起來', pinyin: 'qǐ lái', pos: ['Vc'], glossEn: 'directional/inchoative complement: "-ing up", "seems"' }),
  word({ headword: '高興', pinyin: 'gāo xìng', pos: ['Vs'], glossEn: 'happy; glad' }),

  word({ headword: '家', pinyin: 'jiā', pos: ['N', 'Msr'], glossEn: 'home; family; classifier for shops' }),
  word({ headword: '便利商店', pinyin: 'biàn lì shāng diàn', pos: ['N'], glossEn: 'convenience store', source: 'supplement', tags: ['taiwan-specific'] }),
  word({ headword: '大', pinyin: 'dà', pos: ['Vs'], glossEn: 'big' }),

  word({ headword: '妹妹', pinyin: 'mèi mei', pos: ['N'], glossEn: 'younger sister' }),
  word({ headword: '比', pinyin: 'bǐ', pos: ['Prep'], glossEn: 'compared to' }),
  word({ headword: '三', pinyin: 'sān', pos: ['Num'], glossEn: 'three' }),
  word({ headword: '歲', pinyin: 'suì', pos: ['Msr'], glossEn: 'years (of age)' }),

  word({ headword: '校長', pinyin: 'xiào zhǎng', pos: ['N'], glossEn: 'school principal' }),
  word({ headword: '上班', pinyin: 'shàng bān', pos: ['Vi'], glossEn: 'to go to work' }),

  word({ headword: '銀行', pinyin: 'yín háng', pos: ['N'], glossEn: 'bank' }),
  word({ headword: '九', pinyin: 'jiǔ', pos: ['Num'], glossEn: 'nine' }),
  word({ headword: '點', pinyin: 'diǎn', pos: ['Msr'], glossEn: "o'clock" }),
  word({ headword: '才', pinyin: 'cái', pos: ['Adv'], glossEn: 'only then; not until' }),
  word({ headword: '開門', pinyin: 'kāi mén', pos: ['Vi'], glossEn: 'to open (for business)' }),

  word({ headword: '這樣', pinyin: 'zhè yàng', pos: ['Det'], glossEn: 'like this; this way' }),
  word({ headword: '可行', pinyin: 'kě xíng', pos: ['Vs'], glossEn: 'feasible; workable' }),

  word({ headword: '一', pinyin: 'yī', pos: ['Num'], glossEn: 'one' }),
  word({ headword: '五', pinyin: 'wǔ', pos: ['Num'], glossEn: 'five' }),
  word({ headword: '個', pinyin: 'gè', pos: ['Msr'], glossEn: 'general classifier' }),
  word({ headword: '人', pinyin: 'rén', pos: ['N'], glossEn: 'person' }),

  word({ headword: '包包', pinyin: 'bāo bāo', pos: ['N'], glossEn: 'bag' }),
  word({ headword: '字', pinyin: 'zì', pos: ['N'], glossEn: 'character; word' }),
  word({ headword: '寫', pinyin: 'xiě', pos: ['V'], glossEn: 'to write' }),
  word({ headword: '完', pinyin: 'wán', pos: ['Vc'], glossEn: 'complement: finish doing' }),

  word({ headword: '音樂會', pinyin: 'yīn yuè huì', pos: ['N'], glossEn: 'concert' }),
  word({ headword: '晚上', pinyin: 'wǎn shàng', pos: ['N'], glossEn: 'evening' }),
  word({ headword: '七', pinyin: 'qī', pos: ['Num'], glossEn: 'seven' }),
  word({ headword: '開始', pinyin: 'kāi shǐ', pos: ['V'], glossEn: 'to start' }),

  word({ headword: '每天', pinyin: 'měi tiān', pos: ['N'], glossEn: 'every day' }),
  word({ headword: '都', pinyin: 'dōu', pos: ['Adv'], glossEn: 'all; both' }),
  word({ headword: '過', pinyin: 'guò', pos: ['V'], glossEn: 'to pass/spend (time); to live (a life)' }),
  word({ headword: '快樂', pinyin: 'kuài lè', pos: ['Vs'], glossEn: 'happy; joyful' }),

  word({ headword: '電影', pinyin: 'diàn yǐng', pos: ['N'], glossEn: 'movie' }),
  word({ headword: '無聊', pinyin: 'wú liáo', pos: ['Vs'], glossEn: 'boring' }),
  word({ headword: '部', pinyin: 'bù', pos: ['Msr'], glossEn: 'classifier for films/vehicles' }),

  word({ headword: '手機', pinyin: 'shǒu jī', pos: ['N'], glossEn: 'mobile phone' }),
  word({ headword: '掉', pinyin: 'diào', pos: ['V'], glossEn: 'to drop; to fall' }),
  word({ headword: '地上', pinyin: 'dì shàng', pos: ['N'], glossEn: 'on the ground' }),

  word({ headword: '悠遊卡', pinyin: 'yōu yóu kǎ', pos: ['Nb'], glossEn: 'EasyCard', source: 'supplement', tags: ['taiwan-specific', 'proper-noun'] }),
  word({ headword: '捷運', pinyin: 'jié yùn', pos: ['N'], glossEn: 'MRT/metro', source: 'supplement', tags: ['taiwan-specific'] }),
  word({ headword: '和', pinyin: 'hàn', pos: ['Conj'], glossEn: 'and', senseNote: 'Taiwan reading hàn, not mainland hé' }),
  word({ headword: '使用', pinyin: 'shǐ yòng', pos: ['V'], glossEn: 'to use' }),

  word({ headword: '請問', pinyin: 'qǐng wèn', pos: ['IdiomV'], glossEn: 'excuse me, may I ask...' }),
  word({ headword: '洗手間', pinyin: 'xǐ shǒu jiān', pos: ['N'], glossEn: 'restroom' }),
  word({ headword: '哪裡', pinyin: 'nǎ lǐ', pos: ['N'], glossEn: 'where' }),

  word({ headword: '想', pinyin: 'xiǎng', pos: ['Aux', 'V'], glossEn: 'to want to; to think' }),
  word({ headword: '學', pinyin: 'xué', pos: ['V'], glossEn: 'to learn; to study' }),

  word({ headword: '把', pinyin: 'bǎ', pos: ['Prep'], glossEn: '把-construction marker', tags: ['grammar'] }),
  word({ headword: '作業', pinyin: 'zuò yè', pos: ['N'], glossEn: 'homework' }),

  word({ headword: '昨天', pinyin: 'zuó tiān', pos: ['N'], glossEn: 'yesterday' }),

  word({ headword: '杯', pinyin: 'bēi', pos: ['Msr'], glossEn: 'classifier for cups/glasses' }),
  word({ headword: '多少', pinyin: 'duō shǎo', pos: ['Det'], glossEn: 'how much/many' }),

  word({ headword: '明天', pinyin: 'míng tiān', pos: ['N'], glossEn: 'tomorrow' }),
  word({ headword: '來', pinyin: 'lái', pos: ['V'], glossEn: 'to come' }),

  word({ headword: '約', pinyin: 'yuē', pos: ['V'], glossEn: 'to arrange to meet' }),
  word({ headword: '八', pinyin: 'bā', pos: ['Num'], glossEn: 'eight' }),
  word({ headword: '見面', pinyin: 'jiàn miàn', pos: ['Vi'], glossEn: 'to meet (each other)' }),

  word({ headword: '隻', pinyin: 'zhī', pos: ['Msr'], glossEn: 'classifier for animals' }),
  word({ headword: '貓', pinyin: 'māo', pos: ['N'], glossEn: 'cat' }),

  word({ headword: '你好', pinyin: 'nǐ hǎo', pos: ['IdiomV'], glossEn: 'hello' }),
  word({ headword: '好', pinyin: 'hǎo', pos: ['Vs'], glossEn: 'good' }),

  word({ headword: '打', pinyin: 'dǎ', pos: ['V'], glossEn: 'to hit; to make (a call)' }),
  word({ headword: '電話', pinyin: 'diàn huà', pos: ['N'], glossEn: 'telephone' }),
  word({ headword: '給', pinyin: 'gěi', pos: ['V', 'Prep'], glossEn: 'to give; to' }),

  word({ headword: '電腦', pinyin: 'diàn nǎo', pos: ['N'], glossEn: 'computer' }),
  word({ headword: '爸爸', pinyin: 'bà ba', pos: ['N'], glossEn: 'father' }),

  word({ headword: '訊息', pinyin: 'xùn xí', pos: ['N'], glossEn: 'message', tags: ['taiwan-specific'] }),
  word({ headword: '到', pinyin: 'dào', pos: ['V', 'Vc'], glossEn: 'to arrive; complement: successfully' }),

  word({ headword: '因為', pinyin: 'yīn wèi', pos: ['Conj'], glossEn: 'because' }),

  // 垃圾車 (garbage truck) — explicitly called out in CLAUDE.md as a
  // table-driven test example.
  word({ headword: '垃圾車', pinyin: 'lè sè chē', pos: ['N'], glossEn: 'garbage truck', senseNote: 'Taiwan reading lèsè, not mainland lājī', tags: ['taiwan-specific'] }),
];

export function buildFixtureLexicon(): Lexicon {
  return new Lexicon(FIXTURE_WORDS, []);
}
