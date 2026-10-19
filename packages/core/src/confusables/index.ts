// Phase 23 Part B, Phase 48: look-alike options for "Pick the Mandarin", the homophone picker and the
// look-alike characters exercise. For a target word it picks distractors of the same length, scored
// from what really gets confused: shape (a shared character, a shared phonetic component, the same
// radical with a similar stroke count, a short hand-checked list of classic pairs), sound (the same
// syllables in another tone, homophones) and the learner's own mix-ups. A distractor is never also a
// right answer: other senses of the same characters, variants and synonyms are left out.
// Pure; the seed makes the choice repeatable.

import { CHAR_SHAPES } from '../data/char-shapes.generated.js';
import { MAINLAND_TERMS } from '../data/mainland-terms.generated.js';
import { glossFor } from '../gloss/context.js';
import { hashText } from '../hash.js';
import { displayLevel } from '../level-estimate.js';
import { levelIndex } from '../levels.config.js';
import type { Level, Word } from '../types.js';
import { meaningCategories, samePosFamily } from './categories.js';
import { axesBetween, nearSyllable, oddOneOut, type DistractorAxis } from './fair.js';
import type { DistractorTable } from './table.js';

export * from './categories.js';
export * from './fair.js';
export * from './grammar.js';
export * from './table.js';

export interface CharShape {
  radical: number;
  extraStrokes: number;
  strokes: number;
  /** Unihan kPhonetic groups: characters in a group share a phonetic component. */
  phonetic: string[];
}

const shapeCache = new Map<string, CharShape | null>();

/** Radical, strokes and phonetic groups from Unihan (undefined for characters outside the lexicon). */
export function charShape(ch: string): CharShape | undefined {
  let s = shapeCache.get(ch);
  if (s === undefined) {
    const raw = CHAR_SHAPES[ch];
    if (!raw) s = null;
    else {
      const [rs = '', strokes = '', phon = ''] = raw.split('|');
      const [radical = '0', extra = '0'] = rs.split('.');
      s = {
        radical: Number(radical),
        extraStrokes: Number(extra),
        strokes: Number(strokes),
        phonetic: phon ? phon.split(' ') : [],
      };
    }
    shapeCache.set(ch, s);
  }
  return s ?? undefined;
}

/** Classic look-alike sets that radical and strokes alone miss (or rank too low). Hand-checked. */
export const LOOKALIKE_SETS: readonly string[] = [
  '己已巳',
  '未末',
  '人入八',
  '土士',
  '日曰',
  '大太犬',
  '王玉主',
  '天夫',
  '刀力',
  '千干于',
  '買賣',
  '問間聞',
  '熱熟',
  '今令',
  '午牛',
  '白百自',
  '目且',
  '師帥',
  '候侯',
  '喝渴',
  '住往',
  '鳥烏',
  '木本',
  '免兔',
  '折拆',
  '休体',
  '貝見',
  '左右',
  '冬多',
  '拿拾',
];

const lookalikeOf = new Map<string, Set<string>>();
for (const set of LOOKALIKE_SETS)
  for (const ch of set) lookalikeOf.set(ch, new Set([...(lookalikeOf.get(ch) ?? []), ...[...set].filter((c) => c !== ch)]));

/** How alike two characters look, 0..1. */
export function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (lookalikeOf.get(a)?.has(b)) return 1;
  const sa = charShape(a);
  const sb = charShape(b);
  if (!sa || !sb) return 0;
  let score = 0;
  if (sa.phonetic.some((g) => sb.phonetic.includes(g))) score = Math.max(score, 0.6);
  if (sa.radical === sb.radical) {
    const d = Math.abs(sa.strokes - sb.strokes);
    if (d <= 1) score = Math.max(score, 0.6);
    else if (d <= 2) score = Math.max(score, 0.45);
  }
  return score;
}

// ---------------------------------------------------------------------------------------------
// "Never a correct answer"

const STOP = new Set(['to', 'a', 'an', 'the', 'of', 'be', 'or', 'and', 'one', 'sth', 'sb', 'something', 'someone', 'etc']);

function glossPhrases(w: Pick<Word, 'glossEn' | 'senses' | 'primarySenseId' | 'textbookSenseId'>): string[] {
  const all = [w.glossEn, glossFor(w), ...(w.senses ?? []).map((s) => s.glossEn)];
  const out = new Set<string>();
  for (const g of all)
    for (const part of g.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[;,/]/)) {
      const words = part.split(/[^a-z']+/).filter((t) => t && !STOP.has(t));
      if (words.length > 0) out.add(words.join(' '));
    }
  return [...out];
}

/** Phase 48: Taiwan and mainland forms of the same word (計程車 / 出租車), both ways. */
const mainlandTwins = new Map<string, Set<string>>();
for (const t of MAINLAND_TERMS) {
  const forms = [t.taiwan, ...t.mainland, ...(t.also ?? [])];
  for (const f of forms) mainlandTwins.set(f, new Set([...(mainlandTwins.get(f) ?? []), ...forms.filter((x) => x !== f)]));
}

/** Would `other` also be a right answer for `target`? Same characters (another sense), a variant,
 * a Taiwan / mainland pair (Phase 48), or a synonym (a gloss phrase in common, or most of their
 * gloss words shared). */
export function alsoCorrect(target: Word, other: Word): boolean {
  if (other.id === target.id || other.headword === target.headword) return true;
  if (target.variants.includes(other.headword) || other.variants.includes(target.headword)) return true;
  if (mainlandTwins.get(target.headword)?.has(other.headword)) return true;
  const a = glossPhrases(target);
  const b = new Set(glossPhrases(other));
  if (a.some((p) => b.has(p))) return true;
  const wa = new Set(a.flatMap((p) => p.split(' ')));
  const wb = new Set([...b].flatMap((p) => p.split(' ')));
  const shared = [...wa].filter((t) => wb.has(t)).length;
  const smaller = Math.min(wa.size, wb.size);
  return smaller > 0 && shared / smaller >= 0.6;
}

// ---------------------------------------------------------------------------------------------
// The index and the picker

const toneless = (w: Pick<Word, 'pinyinNumeric'>) =>
  w.pinyinNumeric.trim().toLowerCase().split(/\s+/).map((s) => s.replace(/[0-5]$/, '')).join(' ');
const nearSound = (w: Pick<Word, 'pinyinNumeric'>) => toneless(w).split(' ').map(nearSyllable).join(' ');

/** Words used for distractors: the official list, textbook and the learner's own words; dictionary
 * extras only with a level of their own (lesson extras such as 運動衫) or when the learner knows
 * them (an estimate from easy characters is not enough: 每常, 周口店). */
const mainWord = (w: Word) => w.source !== 'supplement' || w.level !== null;
/** Names never: tagged ones, and dictionary extras glossed like a name ("Zhoukoudian …"). */
const isName = (w: Word) =>
  w.tags.includes('name') || w.tags.includes('proper-noun') || (w.source === 'supplement' && /^[A-Z][a-z]/.test(w.glossEn));

/**
 * Which axes count:
 * - `any` (Review Pick, a Cloze question without a sentence): all of them;
 * - `visual` (Pinyin & tones look-alikes): character and shape;
 * - `sound` (the homophone picker, Listening): sound;
 * - `cloze` (Cloze with a sentence): character, shape and sound, and never a word in the answer's
 *   meaning category (it could fit the sentence too: 常常 for 平常, 巧克力 for 冰淇淋).
 * The learner's own mix-ups always count.
 */
export type ConfusableMode = 'any' | 'visual' | 'sound' | 'cloze';

const MODE_AXES: Record<ConfusableMode, ReadonlySet<DistractorAxis>> = {
  any: new Set(['char', 'shape', 'sound', 'meaning', 'confused']),
  visual: new Set(['char', 'shape', 'confused']),
  sound: new Set(['sound', 'confused']),
  cloze: new Set(['char', 'shape', 'sound', 'confused']),
};

export interface ConfusableOptions {
  /** How many distractors at most (default 3). Fewer when fewer are close: never filler. */
  n?: number;
  mode?: ConfusableMode;
  /** Known, due and current-level word ids: plausible distractors come from these first. */
  preferred?: ReadonlySet<string>;
  /** Word ids the learner mixed up with this target before. */
  confusedWith?: ReadonlySet<string>;
  seed?: string;
  /** Phase 48 B.4: the highest level an option the learner hasn't met may have (their level + 1;
   * the word's own level is always allowed). Absent: any level. */
  levelCap?: Level;
  /** Phase 48 B.5: after 2 right picks in a row, the closest candidates (shared character + same
   * category) instead of a mix of axes. */
  hard?: boolean;
  /** Never a word read exactly the same (Listening: you'd hear both; look-alikes with pinyin shown). */
  excludeSameReading?: boolean;
}

/** One option and the axes it is close to the answer on. */
export interface ConfusableCandidate {
  word: Word;
  axes: ReadonlySet<DistractorAxis>;
}

/** A per-lexicon index so a session's distractors are found without scanning every word each time. */
export class ConfusableIndex {
  private readonly bySound = new Map<string, Word[]>();
  private readonly bySyllable = new Map<string, Word[]>();
  private readonly byChar = new Map<string, Word[]>();
  private readonly byCategory = new Map<string, Word[]>();
  private readonly byId = new Map<string, Word>();
  private readonly similarCache = new Map<string, string[]>();
  private readonly candidateCache = new Map<string, ConfusableCandidate[]>();
  private readonly allChars: string[];
  private table: DistractorTable | undefined;

  constructor(words: readonly Word[], opts: { table?: DistractorTable } = {}) {
    this.table = opts.table;
    for (const w of words) {
      this.byId.set(w.id, w);
      if (!w.pinyinNumeric || isName(w)) continue;
      const len = [...w.headword].length;
      push(this.bySound, `${len}|${nearSound(w)}`, w);
      toneless(w)
        .split(' ')
        .forEach((s, i) => push(this.bySyllable, `${len}|${i}|${s}`, w));
      for (const ch of new Set(w.headword)) push(this.byChar, ch, w);
      for (const c of meaningCategories(w)) push(this.byCategory, `${len}|${c}`, w);
    }
    this.allChars = [...this.byChar.keys()];
  }

  /** Phase 48: attach the offline candidate table (loaded after the lexicon). */
  setTable(table: DistractorTable | undefined): void {
    if (table === this.table) return;
    this.table = table;
    this.candidateCache.clear();
  }

  word(id: string): Word | undefined {
    return this.byId.get(id);
  }

  /** Characters in the lexicon that look like `ch`. */
  similarChars(ch: string): string[] {
    let out = this.similarCache.get(ch);
    if (!out) {
      out = this.allChars.filter((c) => c !== ch && charSimilarity(ch, c) > 0);
      this.similarCache.set(ch, out);
    }
    return out;
  }

  /**
   * Every same-length word close to `target` on at least one axis, with its axes: from the table
   * (Part A, with any checked Gemini suggestions) and the same code axes computed here (so tutoring
   * and custom words have candidates too). Never a word that would also be right, never a name.
   * Learner-independent, cached per word.
   */
  candidates(target: Word): ConfusableCandidate[] {
    const hit = this.candidateCache.get(target.id);
    if (hit) return hit;
    const chars = [...target.headword];
    const len = chars.length;
    const pool = new Map<string, Word>();
    const tableAxes = new Map<string, Set<DistractorAxis>>();
    const add = (w: Word | undefined) => {
      if (w && w.id !== target.id && [...w.headword].length === len && w.pinyinNumeric && !isName(w)) pool.set(w.id, w);
    };
    for (const w of this.bySound.get(`${len}|${nearSound(target)}`) ?? []) add(w);
    if (len >= 2) toneless(target).split(' ').forEach((s, i) => (this.bySyllable.get(`${len}|${i}|${s}`) ?? []).forEach(add));
    for (const ch of chars) {
      for (const w of this.byChar.get(ch) ?? []) add(w);
      for (const s of this.similarChars(ch)) for (const w of this.byChar.get(s) ?? []) add(w);
    }
    for (const c of meaningCategories(target)) for (const w of this.byCategory.get(`${len}|${c}`) ?? []) if (samePosFamily(target, w)) add(w);
    for (const [id, axes] of this.table?.words[target.id] ?? []) {
      const w = this.byId.get(id);
      add(w);
      if (w && axes.split('+').some((a) => a === 'suggest' || a === 'meaning')) tableAxes.set(w.id, new Set(['meaning']));
    }
    const out: ConfusableCandidate[] = [];
    for (const w of pool.values()) {
      if (alsoCorrect(target, w)) continue;
      const axes = axesBetween(target, w, charSimilarity);
      for (const a of tableAxes.get(w.id) ?? []) axes.add(a);
      if (axes.size > 0) out.push({ word: w, axes });
    }
    this.candidateCache.set(target.id, out);
    return out;
  }

  /** Up to `n` distractors of the same length as `target`, best first. Every one is close to the
   * answer on an axis, they mix axes, and the set never makes the answer the odd one out (Phase 48).
   * Fewer (or none) when fewer qualify: the caller shows fewer options or another face. */
  pick(target: Word, opts: ConfusableOptions = {}): Word[] {
    return this.pickDetailed(target, opts).map((c) => c.word);
  }

  pickDetailed(target: Word, opts: ConfusableOptions = {}): ConfusableCandidate[] {
    const n = opts.n ?? 3;
    const mode = opts.mode ?? 'any';
    const allowed = MODE_AXES[mode];
    const seed = opts.seed ?? '';
    const chars = [...target.headword];
    const len = chars.length;
    const preferred = opts.preferred ?? new Set<string>();
    const confused = opts.confusedWith ?? new Set<string>();
    const ownLevel = displayLevel(target);
    const cap =
      opts.levelCap === undefined
        ? Infinity
        : Math.max(levelIndex(opts.levelCap), ownLevel ? levelIndex(ownLevel) : -1);

    const byId = new Map(this.candidates(target).map((c) => [c.word.id, { word: c.word, axes: new Set(c.axes) }]));
    for (const id of confused) {
      const w = this.byId.get(id);
      if (!w || w.id === target.id || [...w.headword].length !== len || !w.pinyinNumeric || alsoCorrect(target, w)) continue;
      const c = byId.get(id) ?? { word: w, axes: axesBetween(target, w, charSimilarity) };
      c.axes.add('confused');
      byId.set(id, c);
    }
    const tNum = target.pinyinNumeric.trim().toLowerCase();
    const eligible = (w: Word): boolean => {
      if (opts.excludeSameReading && w.pinyinNumeric.trim().toLowerCase() === tNum) return false;
      if (preferred.has(w.id) || confused.has(w.id)) return true;
      // dictionary extras and the learner's own words only when known; a level the learner can read
      if (!mainWord(w) || w.source === 'custom') return false;
      const lv = w.level;
      return lv !== null && levelIndex(lv) <= cap;
    };

    const tSyl = toneless(target).split(' ');
    const score = (c: { word: Word; axes: Set<DistractorAxis> }): number => {
      const w = c.word;
      const wc = [...w.headword];
      let s = 0;
      if (c.axes.has('char')) s += (wc.filter((ch, i) => ch === chars[i]).length / len) * 2 + 1;
      if (c.axes.has('shape')) {
        let vis = 0;
        for (let i = 0; i < len; i++) if (wc[i] !== chars[i]) vis += charSimilarity(chars[i]!, wc[i]!);
        s += (vis / len) * 3 + 0.5;
      }
      if (c.axes.has('sound')) {
        const wNum = w.pinyinNumeric.trim().toLowerCase();
        const wSyl = toneless(w).split(' ');
        s += wNum === tNum ? 3 : wSyl.join(' ') === tSyl.join(' ') ? 2.5 : (wSyl.filter((x, i) => x === tSyl[i]).length / len) * 1.5;
      }
      if (c.axes.has('meaning')) s += 2;
      if (c.axes.has('confused')) s += 4;
      if (opts.hard) {
        s += (c.axes.size - 1) * 1.5;
        if (c.axes.has('char') && c.axes.has('meaning')) s += 2;
      }
      if (preferred.has(w.id)) s += 1;
      return s;
    };
    const tie = (w: Word) => parseInt(hashText(`${seed}|${target.id}|${w.id}`), 36) / 2 ** 32;
    const ranked = [...byId.values()]
      .map((c) => ({ ...c, axes: new Set([...c.axes].filter((a) => allowed.has(a))) }))
      .filter((c) => c.axes.size > 0 && eligible(c.word))
      // Cloze: a word in the answer's meaning category could complete the sentence too
      .filter((c) => mode !== 'cloze' || !(byId.get(c.word.id)!.axes.has('meaning') && !c.axes.has('confused')))
      .map((c) => ({ ...c, s: score(c) + tie(c.word) * 0.3 }))
      .sort((a, b) => b.s - a.s);

    const out: Array<{ word: Word; axes: Set<DistractorAxis> }> = [];
    const usedHead = new Set([target.headword]);
    const fits = (c: { word: Word }) =>
      !usedHead.has(c.word.headword) &&
      !out.some((o) => alsoCorrect(o.word, c.word)) &&
      !oddOneOut(target, [...out.map((o) => o.word), c.word]);
    const take = (c: (typeof ranked)[number]) => {
      usedHead.add(c.word.headword);
      out.push(c);
    };
    // Mix the axes: a mix-up first, then one look-alike, one sound-alike and one meaning neighbour,
    // so no single shortcut finds the answer (hard cards: the closest first instead).
    if (!opts.hard)
      for (const group of [['confused'], ['char', 'shape'], ['sound'], ['meaning']] as DistractorAxis[][]) {
        if (out.length >= n) break;
        const c = ranked.find((x) => group.some((a) => x.axes.has(a)) && fits(x));
        if (c) take(c);
      }
    for (const c of ranked) {
      if (out.length >= n) break;
      if (fits(c)) take(c);
    }
    return out.sort((a, b) => score(b) - score(a));
  }
}

const lexiconIndexes = new WeakMap<object, ConfusableIndex>();

/** One index per loaded word list (Review, Cloze, Pinyin, Listening and the leech panel share it). */
export function confusableIndexFor(lexicon: { allWords(): readonly Word[] }): ConfusableIndex {
  let i = lexiconIndexes.get(lexicon);
  if (!i) {
    i = new ConfusableIndex(lexicon.allWords());
    lexiconIndexes.set(lexicon, i);
  }
  return i;
}

/** A seed string from an rng (callers that only have an rng). */
export const seedFromRng = (rng: () => number): string => Math.floor(rng() * 2 ** 32).toString(36);

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Which word ids each word was mixed up with (from wrong picks' `context.pickedId`, both ways). */
export function confusionsFromEvidence(
  evidence: readonly { item: { kind: string; id: string }; context?: { pickedId?: string } }[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (a: string, b: string) => out.set(a, new Set([...(out.get(a) ?? []), b]));
  for (const e of evidence) {
    const other = e.context?.pickedId;
    if (!other || e.item.kind !== 'word' || other === e.item.id) continue;
    add(e.item.id, other);
    add(other, e.item.id);
  }
  return out;
}
