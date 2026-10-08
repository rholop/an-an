import { parseTypedPinyinSyllable, parseZhuyinSyllable, toneMismatches, type ParsedSyllable } from '../cloze/grading.js';
import { normaliseAnswer } from '../journal/normalize.js';
import { segment } from '../segment.js';
import type { Lexicon } from '../lexicon.js';
import type { Evidence, Word } from '../types.js';
import { LISTENING_CONFIG } from './config.js';
import { toneless, wordTones } from './tones.js';

export type DictationOutcome = 'correct' | 'wrong_tone' | 'wrong';

export interface WordDictationResult {
  outcome: DictationOutcome;
  /** Syllable indexes (0-based) whose tone was wrong or missing — shown in the feedback. */
  toneWrongAt: number[];
  /** What kind of answer was typed, so feedback can speak the learner's language. */
  input: 'characters' | 'pinyin' | 'zhuyin' | 'empty';
}

const HAN = /[\u3400-\u9fff]/;
const ZHUYIN = /[\u3105-\u312f\u31a0-\u31bf]/;

const splitZhuyin = (z: string) => z.trim().split(/\s+/).filter(Boolean);

/** Word dictation: characters, pinyin or zhuyin. Pinyin/zhuyin must carry tones. */
export function gradeWordDictation(
  typedRaw: string,
  word: Pick<Word, 'headword' | 'variants' | 'pinyinNumeric' | 'zhuyin'>,
): WordDictationResult {
  const typed = typedRaw.trim();
  if (!typed) return { outcome: 'wrong', toneWrongAt: [], input: 'empty' };
  if (HAN.test(typed)) {
    const ok = [word.headword, ...word.variants].map(normaliseAnswer).includes(normaliseAnswer(typed));
    return { outcome: ok ? 'correct' : 'wrong', toneWrongAt: [], input: 'characters' };
  }
  const wantTones = wordTones(word);
  if (ZHUYIN.test(typed)) {
    // Phase 21: the shared zhuyin parser (˙ before or after the syllable).
    const want = splitZhuyin(word.zhuyin).map(parseZhuyinSyllable);
    const got = splitZhuyin(typed).map(parseZhuyinSyllable);
    return compareSyllables(want, got, 'zhuyin');
  }
  const wantBase = toneless(word);
  const syllables = typed.split(/[\s']+/).filter(Boolean).map(parseTypedPinyinSyllable);
  return compareSyllables(
    wantBase.map((b, i) => ({ base: b, tone: wantTones[i] ?? 5 })),
    syllables,
    'pinyin',
  );
}

function compareSyllables(
  want: Array<{ base: string; tone: number }>,
  got: ParsedSyllable[],
  input: 'pinyin' | 'zhuyin',
): WordDictationResult {
  if (want.length !== got.length || want.some((w, i) => w.base !== got[i]!.base))
    return { outcome: 'wrong', toneWrongAt: [], input };
  // Phase 21: the shared rule (an unmarked pinyin syllable is accepted for a neutral tone).
  const bad = toneMismatches(got, want);
  return bad.length === 0
    ? { outcome: 'correct', toneWrongAt: [], input }
    : { outcome: 'wrong_tone', toneWrongAt: bad, input };
}

/** How a result is rated: first-play correct = Good; replayed (2+) / slow / wrong tone = Hard; wrong = Again. */
export function listeningEvidenceKind(
  outcome: DictationOutcome,
  usage: { replays: number; slow: boolean },
): Evidence['kind'] {
  if (outcome === 'wrong') return 'listening_wrong';
  if (outcome === 'wrong_tone') return 'listening_correct_replayed';
  return usage.replays >= LISTENING_CONFIG.hardAfterReplays || usage.slow
    ? 'listening_correct_replayed'
    : 'listening_correct';
}

// ---- sentence dictation ------------------------------------------------------

export interface DiffPart {
  text: string;
  status: 'ok' | 'missed' | 'extra';
}

export interface SentenceDictationResult {
  /** Target words in order, each hit or missed — one listening evidence per word. */
  words: Array<{ text: string; wordId?: string; hit: boolean }>;
  /** The diff to show: matched words, missed (highlighted) and extra ones. */
  diff: DiffPart[];
  allCorrect: boolean;
}

const wordTokens = (text: string, lexicon: Lexicon): string[] =>
  segment(text, lexicon)
    .filter((t) => t.kind === 'word' || t.kind === 'number' || t.kind === 'latin')
    .map((t) => t.text);

/** Grades word by word with the segmenter (punctuation ignored); LCS keeps the diff stable. */
export function gradeSentenceDictation(
  typed: string,
  target: string,
  lexicon: Lexicon,
): SentenceDictationResult {
  const want = wordTokens(target, lexicon);
  const got = wordTokens(typed, lexicon);
  const n = want.length;
  const m = got.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = want[i] === got[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const diff: DiffPart[] = [];
  const hits = new Array<boolean>(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && want[i] === got[j]) {
      diff.push({ text: want[i]!, status: 'ok' });
      hits[i] = true;
      i++;
      j++;
    } else if (i < n && (j >= m || L[i + 1]![j]! >= L[i]![j + 1]!)) {
      diff.push({ text: want[i]!, status: 'missed' });
      i++;
    } else {
      diff.push({ text: got[j]!, status: 'extra' });
      j++;
    }
  }
  const words = want.map((text, k) => ({
    text,
    wordId: lexicon.lookup(text)[0]?.id,
    hit: hits[k]!,
  }));
  return { words, diff, allCorrect: words.every((w) => w.hit) && !diff.some((d) => d.status === 'extra') };
}
