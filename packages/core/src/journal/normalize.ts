// Phase 21 Part I: the ONE normaliser for typed answers (cloze, journal error items, listening
// dictation): NFKC, then spaces and one shared punctuation set are ignored.
const STRIP = /[\s，。、！？,.!?；;：:「」『』"'“”‘’（）()…—\-～~]/g;

/** Typed Chinese/pinyin/zhuyin comparison form: NFKC, spaces and punctuation ignored. */
export const normaliseAnswer = (s: string): string => s.normalize('NFKC').replace(STRIP, '');

/** Neutral tone as a digit, the same in tone checks and typed pinyin ("ma5"; 0 is accepted too). */
export const NEUTRAL_TONE_DIGIT = '5';
export const toneDigit = (tone: number): string => (tone === 5 || tone === 0 ? NEUTRAL_TONE_DIGIT : String(tone));
