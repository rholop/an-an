// Phase 24: an offline stand-in for the story writer and the independent reader (dev, tests and
// the eval's --dry run). Built only from the request's own word lists, one word per comma, so it
// always meets the shares: it proves the harness, it is not model output.
import { hanCount } from './index.js';
import type {
  StoryCheckRequest,
  StoryCheckResponse,
  StoryRepairRequest,
  StoryRepairResponse,
  StoryRequest,
  StoryResponse,
} from './types.js';

export function dryStoryCheck(req: StoryCheckRequest): StoryCheckResponse {
  // The fake writer always puts the right option first.
  return {
    natural: true,
    coherent: true,
    taiwan: true,
    summaryMatches: true,
    problems: [],
    correctOptions: req.questions.map(() => [0]),
    glossesOk: true,
  };
}

/** Phase 26: the stand-in repair swaps each problem word for its first suggestion (or drops it). */
export function dryStoryRepair(req: StoryRepairRequest): StoryRepairResponse {
  return {
    sentences: req.sentences.map((s) => ({
      i: s.i,
      zh: s.problems.reduce((zh, p) => zh.split(p.zh).join(p.swaps[0] ?? ''), s.zh) || s.zh,
    })),
    paragraphsEn: [],
    newWords: [],
  };
}

export function dryStory(req: StoryRequest): StoryResponse {
  const r1 = req.rungs.r1.length > 0 ? req.rungs.r1 : ['我'];
  const extra = [
    ...req.rungs.r2.slice(0, 2).flatMap((w) => [w, w]),
    ...req.rungs.r3.slice(0, Math.min(1, req.budget.rung3)),
  ];
  // with no lesson words, one word from the level (Middle allows one)
  if (extra.length === 0 && req.budget.rung5 > 0 && req.rungs.r5[0]) extra.push(req.rungs.r5[0]);
  // Enough rung 1 words around the extras to keep rung 1 at ~95%.
  const sentences: string[] = [];
  let i = 0;
  let chars = 0;
  const need = Math.min(Math.max(req.length.min, extra.length * 25), req.length.max);
  const words: string[] = [];
  while (chars < need && i < 2000) {
    const w = r1[i % r1.length]!;
    words.push(w);
    chars += hanCount(w);
    i++;
  }
  const step = Math.max(1, Math.floor(words.length / Math.max(1, extra.length + 1)));
  extra.forEach((w, k) => words.splice((k + 1) * step + k, 0, w));
  for (let k = 0; k < words.length; k += 4) sentences.push(`${words.slice(k, k + 4).join('，')}。`);
  const half = Math.ceil(sentences.length / 2);
  const paragraphs = [sentences.slice(0, half).join(''), sentences.slice(half).join('')].filter(
    Boolean,
  );
  const inStory = r1[0]!;
  const notIn = ['飛機', '電腦', '醫生'].filter((x) => !words.includes(x));
  return {
    title_zh: '我的一天',
    title_en: 'My day',
    paragraphs: paragraphs.map((zh, n) => ({ zh, en: `Paragraph ${n + 1} in English.` })),
    summary_en: `A short practice story about ${req.topic}.`,
    glosses: [],
    newWords: req.rungs.r3.filter((w) => words.includes(w)).map((zh) => ({ zh, en: zh })),
    characters: [],
    questions: [
      {
        q_zh: '故事裡有哪個詞？',
        q_en: 'Which word is in the story?',
        options: [inStory, ...notIn.slice(0, 2)].map((zh) => ({ zh, en: zh })),
        answer: 0,
      },
      {
        q_zh: '這是什麼故事？',
        q_en: 'What kind of story is this?',
        options: ['我的一天', '一個電腦', '一個醫生'].map((zh) => ({ zh, en: zh })),
        answer: 0,
      },
    ],
  };
}
