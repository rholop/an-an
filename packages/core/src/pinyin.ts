// Pinyin normalization, tone extraction, and a from-scratch pinyin -> zhuyin
// (bopomofo) converter. Kept dependency-free and pure so it can run both in
// packages/core (reading resolution) and packages/data-pipeline (build-time
// fallback when MOE has no entry for a character/word).
//
// Why write our own converter instead of using MOE's bopomofo everywhere:
// MOE only covers words/characters it has an entry for. Custom/supplement
// words (NPC names, rare chars) need a fallback — see phase doc §"Reading
// verification". This file *is* that "tested pinyin→zhuyin converter".

// Some source spreadsheets (observed in data/raw/tocfl-words.xlsx) mix the
// correct tone-3 caron (e.g. ǎ, U+01CE) with a similar-looking but wrong
// breve (e.g. ă, U+0103) depending on the vowel, and use the Cyrillic/IPA
// "script a" glyph (ɑ) as a stylistic stand-in for "a". None of that is
// valid Hanyu Pinyin Unicode; normalize before anything else touches it.
const BREVE_TO_CARON: Record<string, string> = {
  ă: 'ǎ',
  ĕ: 'ě', // already caron in Unicode, kept for symmetry/documentation
  ĭ: 'ǐ',
  ŏ: 'ǒ',
  ŭ: 'ǔ',
  Ă: 'Ǎ',
  Ĕ: 'Ě',
  Ĭ: 'Ǐ',
  Ŏ: 'Ǒ',
  Ŭ: 'Ǔ',
};

export function normalizePinyinText(raw: string): string {
  let s = raw.normalize('NFC');
  s = s.replace(/\u200B/g, ''); // zero-width space
  s = s.replace(/ɑ/g, 'a').replace(/Ɑ/g, 'A');
  s = s.replace(/[ăĕĭŏŭĂĔĬŎŬ]/g, (ch) => BREVE_TO_CARON[ch] ?? ch);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

type ToneNumber = 1 | 2 | 3 | 4 | 5;

// vowel-with-mark -> [plain vowel, tone]
const TONE_MARKS: Record<string, [string, ToneNumber]> = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['ü', 1], ǘ: ['ü', 2], ǚ: ['ü', 3], ǜ: ['ü', 4],
};

export interface ToneParseResult {
  base: string; // toneless syllable, ü kept as "u:" is NOT used — kept as "ü"
  tone: ToneNumber; // 5 = neutral
}

/** Parse a single pinyin syllable (no spaces) into base spelling + tone number. */
export function parseSyllableTone(syllableRaw: string): ToneParseResult {
  const syllable = normalizePinyinText(syllableRaw);
  let base = '';
  let tone: ToneNumber = 5;
  for (const ch of syllable) {
    const marked = TONE_MARKS[ch.toLowerCase()];
    if (marked) {
      const [plain, t] = marked;
      base += ch === ch.toUpperCase() && ch.toLowerCase() !== ch ? plain.toUpperCase() : plain;
      tone = t;
    } else {
      base += ch;
    }
  }
  return { base, tone };
}

/** Split a multi-syllable pinyin string ("wǒ men", "kāfēi") on whitespace only.
 * Words where the source gives no inter-syllable space (common in the TOCFL
 * list) are handled by the caller falling back to per-character MOE lookups
 * rather than guessing syllable boundaries here — splitting Mandarin pinyin
 * without spaces is ambiguous in general. */
export function splitPinyinSyllables(pinyin: string): string[] {
  return normalizePinyinText(pinyin).split(' ').filter(Boolean);
}

/** "wǒ men" -> "wo3 men5" (CLAUDE.md `pinyinNumeric` shape: space-separated
 * syllable+tone-digit, neutral tone = 5). */
export function toPinyinNumeric(pinyin: string): string {
  return splitPinyinSyllables(pinyin)
    .map((syl) => {
      const { base, tone } = parseSyllableTone(syl);
      return `${base.toLowerCase()}${tone}`;
    })
    .join(' ');
}

// --- pinyin -> zhuyin -----------------------------------------------------

const INITIALS: [string, string][] = [
  ['zh', 'ㄓ'], ['ch', 'ㄔ'], ['sh', 'ㄕ'],
  ['b', 'ㄅ'], ['p', 'ㄆ'], ['m', 'ㄇ'], ['f', 'ㄈ'],
  ['d', 'ㄉ'], ['t', 'ㄊ'], ['n', 'ㄋ'], ['l', 'ㄌ'],
  ['g', 'ㄍ'], ['k', 'ㄎ'], ['h', 'ㄏ'],
  ['j', 'ㄐ'], ['q', 'ㄑ'], ['x', 'ㄒ'],
  ['r', 'ㄖ'], ['z', 'ㄗ'], ['c', 'ㄘ'], ['s', 'ㄙ'],
];

// finals keyed by their spelling *after* the initial has been stripped,
// for the standard (non y/w-initial) case.
const FINALS: [string, string][] = [
  // longest first so e.g. "iang" matches before "ia"
  ['iang', 'ㄧㄤ'], ['iong', 'ㄩㄥ'], ['uang', 'ㄨㄤ'],
  ['ing', 'ㄧㄥ'], ['ang', 'ㄤ'], ['eng', 'ㄥ'], ['ong', 'ㄨㄥ'],
  ['ian', 'ㄧㄢ'], ['iao', 'ㄧㄠ'], ['uai', 'ㄨㄞ'], ['uan', 'ㄨㄢ'],
  ['ueng', 'ㄨㄥ'], ['ai', 'ㄞ'], ['ei', 'ㄟ'], ['ao', 'ㄠ'], ['ou', 'ㄡ'],
  ['an', 'ㄢ'], ['en', 'ㄣ'], ['er', 'ㄦ'],
  ['ia', 'ㄧㄚ'], ['ie', 'ㄧㄝ'], ['iu', 'ㄧㄡ'], ['in', 'ㄧㄣ'],
  ['ua', 'ㄨㄚ'], ['uo', 'ㄨㄛ'], ['ui', 'ㄨㄟ'], ['un', 'ㄨㄣ'],
  ['üe', 'ㄩㄝ'], ['üan', 'ㄩㄢ'], ['ün', 'ㄩㄣ'],
  ['i', 'ㄧ'], ['u', 'ㄨ'], ['ü', 'ㄩ'], ['v', 'ㄩ'],
  ['a', 'ㄚ'], ['o', 'ㄛ'], ['e', 'ㄜ'], ['ê', 'ㄝ'],
];

// zero-initial (y/w/standalone-ü) syllables spelled out in full, since the
// pinyin glide letters y/w don't correspond 1:1 to zhuyin's ㄧㄨㄩ medials.
const ZERO_INITIAL_FULL: Record<string, string> = {
  yi: 'ㄧ', ya: 'ㄧㄚ', ye: 'ㄧㄝ', yao: 'ㄧㄠ', you: 'ㄧㄡ', yiu: 'ㄧㄡ',
  yan: 'ㄧㄢ', yin: 'ㄧㄣ', yang: 'ㄧㄤ', ying: 'ㄧㄥ', yong: 'ㄩㄥ',
  wu: 'ㄨ', wa: 'ㄨㄚ', wo: 'ㄨㄛ', wai: 'ㄨㄞ', wei: 'ㄨㄟ',
  wan: 'ㄨㄢ', wen: 'ㄨㄣ', wang: 'ㄨㄤ', weng: 'ㄨㄥ',
  yu: 'ㄩ', yue: 'ㄩㄝ', yuan: 'ㄩㄢ', yun: 'ㄩㄣ',
  // standalone syllables with no initial at all
  a: 'ㄚ', o: 'ㄛ', e: 'ㄜ', ai: 'ㄞ', ei: 'ㄟ', ao: 'ㄠ', ou: 'ㄡ',
  an: 'ㄢ', en: 'ㄣ', ang: 'ㄤ', eng: 'ㄥ', er: 'ㄦ',
};

// zh/ch/sh/r/z/c/s + "i" is a buzzed vowel with no separate zhuyin glyph.
const APICAL_VOWEL_INITIALS = new Set(['zh', 'ch', 'sh', 'r', 'z', 'c', 's']);

const TONE_SUFFIX: Record<ToneNumber, string> = {
  1: '',
  2: 'ˊ',
  3: 'ˇ',
  4: 'ˋ',
  5: '˙', // neutral tone: conventionally prefixed, applied by the caller
};

/** Convert one toneless pinyin syllable (already lowercase, e.g. "zhang",
 * "wo", "jiong") to zhuyin, without a tone mark. Throws on inputs it can't
 * parse so callers can flag the row rather than silently emit garbage. */
export function pinyinSyllableToZhuyinBase(base: string): string {
  const s = base.toLowerCase().replace(/v/g, 'ü');

  if (s in ZERO_INITIAL_FULL) return ZERO_INITIAL_FULL[s]!;

  for (const [initial, zIni] of INITIALS) {
    if (s.startsWith(initial)) {
      let rest = s.slice(initial.length);
      if (rest === 'i' && APICAL_VOWEL_INITIALS.has(initial)) {
        return zIni; // zhi/chi/shi/ri/zi/ci/si
      }
      if (rest === '') {
        throw new Error(`pinyinSyllableToZhuyinBase: "${base}" has no final`);
      }
      // After j/q/x, pinyin spells ü as plain "u" (dots are dropped) — the
      // u-medial finals (ua/uo/uai/uei/uang/ueng) never follow j/q/x, so
      // "u"/"ue"/"uan"/"un" here unambiguously mean ü/üe/üan/ün.
      if ((initial === 'j' || initial === 'q' || initial === 'x') && /^u(e|an|n)?$/.test(rest)) {
        rest = 'ü' + rest.slice(1);
      }
      for (const [final, zFin] of FINALS) {
        if (rest === final) return zIni + zFin;
      }
      throw new Error(`pinyinSyllableToZhuyinBase: unrecognized final "${rest}" in "${base}"`);
    }
  }

  throw new Error(`pinyinSyllableToZhuyinBase: unrecognized syllable "${base}"`);
}

/** Convert a full toned pinyin syllable ("zhǎng") to zhuyin with tone mark
 * ("ㄓㄤˇ"). Neutral tone is prefixed (˙ㄇㄣ), matching MOE's own convention. */
export function pinyinSyllableToZhuyin(syllableRaw: string): string {
  const { base, tone } = parseSyllableTone(syllableRaw);
  const zBase = pinyinSyllableToZhuyinBase(base);
  if (tone === 5) return TONE_SUFFIX[5] + zBase;
  return zBase + TONE_SUFFIX[tone];
}

/** Convert a full pinyin string, one or more space-separated syllables, to a
 * space-separated zhuyin string (mirrors MOE's own bopomofo formatting). */
export function pinyinToZhuyin(pinyin: string): string {
  return splitPinyinSyllables(pinyin).map(pinyinSyllableToZhuyin).join(' ');
}
