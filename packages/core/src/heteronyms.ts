// Small context-rule table for single-character heteronyms — the characters
// called out explicitly in CLAUDE.md / phase doc §"resolveReading":
// 了 得 行 長 重 還 著 為 地 的 調 樂 覺.
//
// Phrase-level lexicon lookup (see reading.ts) always runs first and covers
// the vast majority of cases (長度, 覺得, 睡覺, 銀行 are each their own
// lexicon entries with their own fixed reading). This table only fires when
// a heteronym character surfaces as its *own* single-character token, where
// the correct reading depends on the surrounding words.
//
// Each rule is a small, explainable heuristic, not a parser: if nothing
// matches, we fall back to the character's most common reading and mark
// confidence 'low' rather than guess-and-call-it-'high'. Per the acceptance
// criteria, a 'low' confidence answer is fine; a confident wrong one isn't.

export type Confidence = 'high' | 'medium' | 'low';

export interface HeteronymContext {
  before?: string; // text of the token immediately before, if any
  after?: string; // text of the token immediately after, if any
}

export interface HeteronymReading {
  pinyinBase: string; // base reading used to match against lexicon Word.pinyin, e.g. "hai2"
  confidenceIfMatched: Confidence;
}

interface HeteronymRule {
  reading: string; // key into the char's readings, matched by first-syllable prefix of pinyin
  test: (ctx: HeteronymContext) => boolean;
}

interface HeteronymEntry {
  default: string; // pinyin (first syllable, toneless-insensitive prefix) used when no rule matches
  rules: HeteronymRule[];
}

const startsWithAny = (s: string | undefined, chars: string): boolean =>
  !!s && chars.includes(s[0] ?? '\0');

export const HETERONYM_TABLE: Record<string, HeteronymEntry> = {
  了: {
    default: 'le',
    rules: [
      // 不了 (can't/won't) / verb+不了 potential complement -> liǎo
      { reading: 'liao', test: (c) => c.before === '不' },
      // V 得了 potential complement -> liǎo
      { reading: 'liao', test: (c) => c.before === '得' },
    ],
  },
  還: {
    default: 'hai', // "still/yet/also" — more frequent as a standalone token
    rules: [
      // 還我 / 還錢 / 還書 etc.: 還 + pronoun/noun object -> huán (to return)
      { reading: 'huan', test: (c) => startsWithAny(c.after, '我你他她錢書東西款') },
      // 就/也/都 + 還 -> hái ("still")
      { reading: 'hai', test: (c) => startsWithAny(c.before, '就也都') },
      { reading: 'hai', test: (c) => startsWithAny(c.after, '沒是有要會在很沒不') },
    ],
  },
  長: {
    default: 'chang', // "long" (adjective) is the more frequent standalone reading
    rules: [
      { reading: 'chang', test: (c) => startsWithAny(c.before, '很太好非常比較多') },
      { reading: 'chang', test: (c) => startsWithAny(c.after, '度短') },
      // 長大 / 長出 -> zhǎng (to grow)
      { reading: 'zhang', test: (c) => startsWithAny(c.after, '大出高') },
    ],
  },
  得: {
    default: 'de', // structural particle (說得很好, 跑得快) — by far the most common standalone use
    rules: [
      // 得 as "must/have to" (děi): pronoun subject before it, verb after —
      // e.g. 我得走了. Structural 得 instead follows a verb (說得/走得/做得).
      {
        reading: 'dei',
        test: (c) => startsWithAny(c.before, '我你他她') && startsWithAny(c.after, '走去做說看要'),
      },
    ],
  },
  行: {
    default: 'xing', // "okay/fine", "to go/act" — common in casual speech
    rules: [
      // 銀行/一行人 etc. mostly covered by lexicon phrase lookup; standalone
      // 行 meaning "row/profession" (háng) typically follows a number/量詞
      { reading: 'hang', test: (c) => startsWithAny(c.before, '一二三幾這那外內') },
    ],
  },
  重: {
    default: 'zhong', // "heavy" is the more frequent standalone adjective reading
    rules: [
      // 重來/重做/重新/重寫 -> chóng ("again/re-")
      { reading: 'chong', test: (c) => startsWithAny(c.after, '來做新複寫') },
    ],
  },
  著: {
    default: 'zhe', // continuous-aspect particle, by far the most common standalone use
    rules: [
      // 找著/睡著(as in "asleep") -> zháo (achieved result)
      { reading: 'zhao', test: (c) => startsWithAny(c.before, '找睡碰猜') },
    ],
  },
  為: {
    default: 'wei4', // 為了/因為 "for/because of" — but lexicon phrase lookup handles those; standalone default is the wèi (for the sake of) sense
    rules: [
      // 以為/成為/作為 -> wéi (to act as/become) — mostly phrase lookup, but
      // 為 immediately followed by a noun complement often reads wéi
      { reading: 'wei2', test: (c) => startsWithAny(c.before, '以成作視') },
    ],
  },
  地: {
    default: 'di4', // "place/land" noun sense
    rules: [
      // adverbial 地 (V-adv/adj + 地 + verb) -> de, but this is rare as a
      // standalone token since it's usually tokenized with its adjective;
      // kept as a documented low-confidence default rather than guessing.
    ],
  },
  的: {
    default: 'de',
    rules: [
      // 目的/的確 handled by phrase lookup; standalone 的 is overwhelmingly
      // the possessive/attributive particle.
    ],
  },
  調: {
    default: 'diao4', // 調整/調查 "to adjust/investigate" — common verb sense
    rules: [
      // 調 + 子/性 -> tiáo (tune/pitch, or "to mix/adjust in cooking")
      { reading: 'tiao2', test: (c) => startsWithAny(c.after, '子皮味味和') },
    ],
  },
  樂: {
    default: 'le4', // "happy" — common standalone adjective
    rules: [
      // 音樂/樂器 handled by phrase lookup; 樂 preceded by 音/音樂 root -> yuè
      { reading: 'yue4', test: (c) => startsWithAny(c.before, '音') },
    ],
  },
  覺: {
    default: 'jue2', // 覺得/感覺 "to feel/sense" — common standalone verb root
    rules: [
      // 睡 + 覺 -> jiào (sleep, noun) — normally one lexicon token 睡覺, kept
      // as a defensive rule in case the segmenter ever splits it.
      { reading: 'jiao4', test: (c) => c.before === '睡' },
    ],
  },
};

export interface HeteronymCandidate {
  /** e.g. Word.pinyin first syllable, numeric-toned, lowercase: "hai2" */
  pinyinBaseNumeric: string;
}

/**
 * Pick which candidate reading (drawn from the lexicon's Word entries for
 * this exact single character) matches the rule table's chosen reading key.
 * Returns undefined if the table has no entry for this character at all
 * (i.e. it isn't a known heteronym) — callers should treat that as "use the
 * only candidate, confidence high" rather than calling this function.
 */
export function pickHeteronymReading<T extends HeteronymCandidate>(
  char: string,
  context: HeteronymContext,
  candidates: T[],
): { candidate: T; confidence: Confidence } | undefined {
  const entry = HETERONYM_TABLE[char];
  if (!entry || candidates.length === 0) return undefined;

  // Compare toneless syllable bases for exact equality — NOT startsWith,
  // which would wrongly match e.g. key "de" against candidate "dei3".
  const toneless = (s: string) => s.toLowerCase().replace(/\d$/, '');
  const matchKey = (key: string, cand: T): boolean => toneless(cand.pinyinBaseNumeric) === toneless(key);

  for (const rule of entry.rules) {
    if (rule.test(context)) {
      const cand = candidates.find((c) => matchKey(rule.reading, c));
      if (cand) return { candidate: cand, confidence: 'medium' };
    }
  }

  const defaultCand = candidates.find((c) => matchKey(entry.default, c));
  if (defaultCand) {
    // Only one candidate anyway -> no real ambiguity, else it's an unresolved guess.
    return { candidate: defaultCand, confidence: candidates.length === 1 ? 'high' : 'low' };
  }

  // Table's default reading isn't even among the lexicon's candidates for
  // this char — don't guess, let the caller fall back to candidates[0] with low confidence.
  return { candidate: candidates[0]!, confidence: 'low' };
}
