const STRIP = /[\s，。、！？,.!?；;：:「」『』"'（）()…—]/g;

/** Phase 4's comparison rules for typed Chinese: NFKC, spaces and punctuation
 * ignored. */
export const normaliseAnswer = (s: string): string => s.normalize('NFKC').replace(STRIP, '');
