import { MAINLAND_TERMS } from './data/mainland-terms.generated.js';
import { SIMPLIFIED_ONLY_CHARS } from './data/simplified-chars.generated.js';

export interface SimplifiedCharHit {
  char: string;
  traditional: string;
  index: number; // char offset in the input text
}

export interface MainlandTermHit {
  matched: string; // the exact substring found
  taiwan: string;
  note?: string;
  index: number;
}

export interface TaiwannessResult {
  simplifiedChars: SimplifiedCharHit[];
  mainlandTerms: MainlandTermHit[];
  isClean: boolean;
}

export function isSimplifiedOnly(ch: string): boolean {
  return ch in SIMPLIFIED_ONLY_CHARS;
}

/** Longest mainland-term spelling first, so e.g. "視頻通話" wins over "視頻". */
const SORTED_TERMS = [...MAINLAND_TERMS]
  .flatMap((entry) => entry.mainland.map((m) => ({ spelling: m, entry })))
  .sort((a, b) => b.spelling.length - a.spelling.length);

export function checkTaiwanness(text: string): TaiwannessResult {
  const chars = [...text];
  const simplifiedChars: SimplifiedCharHit[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (isSimplifiedOnly(ch)) {
      simplifiedChars.push({ char: ch, traditional: SIMPLIFIED_ONLY_CHARS[ch]!, index: i });
    }
  }

  const mainlandTerms: MainlandTermHit[] = [];
  const covered = new Array(chars.length).fill(false);
  for (const { spelling, entry } of SORTED_TERMS) {
    const spellingChars = [...spelling];
    let fromIndex = 0;
    while (true) {
      const idx = text.indexOf(spelling, fromIndex);
      if (idx === -1) break;
      const charIdx = [...text.slice(0, idx)].length;
      const alreadyCovered = covered.slice(charIdx, charIdx + spellingChars.length).some(Boolean);
      if (!alreadyCovered) {
        mainlandTerms.push({ matched: spelling, taiwan: entry.taiwan, note: entry.note, index: charIdx });
        for (let i = charIdx; i < charIdx + spellingChars.length; i++) covered[i] = true;
      }
      fromIndex = idx + spelling.length;
    }
  }
  mainlandTerms.sort((a, b) => a.index - b.index);

  return {
    simplifiedChars,
    mainlandTerms,
    isClean: simplifiedChars.length === 0 && mainlandTerms.length === 0,
  };
}
