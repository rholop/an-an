// Phase 23 Part B: look-alike options for "Pick the Mandarin", the homophone picker and the
// look-alike characters exercise. For a target word it picks distractors of the same length, scored
// from what really gets confused: shape (a shared character, a shared phonetic component, the same
// radical with a similar stroke count, a short hand-checked list of classic pairs), sound (the same
// syllables in another tone, homophones) and the learner's own mix-ups. A distractor is never also a
// right answer: other senses of the same characters, variants and synonyms are left out.
// Pure; the seed makes the choice repeatable.

import { CHAR_SHAPES } from '../data/char-shapes.generated.js';
import { glossFor } from '../gloss/context.js';
import { hashText } from '../hash.js';
import type { Word } from '../types.js';

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

/** Would `other` also be a right answer for `target`? Same characters (another sense), a variant,
 * or a synonym (a gloss phrase in common, or most of their gloss words shared). */
export function alsoCorrect(target: Word, other: Word): boolean {
  if (other.id === target.id || other.headword === target.headword) return true;
  if (target.variants.includes(other.headword) || other.variants.includes(target.headword)) return true;
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

/** Words used for distractors: the official list, textbook and the learner's own words (dictionary
 * extras only when the learner knows them). */
const mainWord = (w: Word) => w.source !== 'supplement';

export type ConfusableMode = 'any' | 'visual' | 'sound';

export interface ConfusableOptions {
  /** How many distractors (default 3). */
  n?: number;
  mode?: ConfusableMode;
  /** Known, due and current-level word ids: plausible distractors come from these first. */
  preferred?: ReadonlySet<string>;
  /** Word ids the learner mixed up with this target before. */
  confusedWith?: ReadonlySet<string>;
  seed?: string;
}

/** A per-lexicon index so a session's distractors are found without scanning every word each time. */
export class ConfusableIndex {
  private readonly byLength = new Map<number, Word[]>();
  private readonly bySound = new Map<string, Word[]>();
  private readonly byChar = new Map<string, Word[]>();
  private readonly byId = new Map<string, Word>();
  private readonly similarCache = new Map<string, string[]>();
  private readonly allChars: string[];

  constructor(words: readonly Word[]) {
    for (const w of words) {
      this.byId.set(w.id, w);
      const len = [...w.headword].length;
      if (!mainWord(w) || !w.pinyinNumeric) continue;
      push(this.byLength, len, w);
      push(this.bySound, toneless(w), w);
      for (const ch of new Set(w.headword)) push(this.byChar, ch, w);
    }
    this.allChars = [...this.byChar.keys()];
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

  /** Up to `n` distractors of the same length as `target`, best first. Fewer only when the
   * lexicon has nothing else of that length. */
  pick(target: Word, opts: ConfusableOptions = {}): Word[] {
    const n = opts.n ?? 3;
    const mode = opts.mode ?? 'any';
    const seed = opts.seed ?? '';
    const chars = [...target.headword];
    const len = chars.length;
    const preferred = opts.preferred ?? new Set<string>();
    const confused = opts.confusedWith ?? new Set<string>();
    const pool = new Map<string, Word>();
    const add = (w: Word | undefined) => {
      if (w && [...w.headword].length === len && w.pinyinNumeric) pool.set(w.id, w);
    };
    if (mode !== 'visual') for (const w of this.bySound.get(toneless(target)) ?? []) add(w);
    if (mode !== 'sound')
      for (const ch of chars) {
        for (const w of this.byChar.get(ch) ?? []) add(w);
        for (const s of this.similarChars(ch)) for (const w of this.byChar.get(s) ?? []) add(w);
      }
    if (mode === 'sound') {
      // near-homophones: one syllable the same, for words of 1–2 syllables
      for (const ch of chars) for (const w of this.byChar.get(ch) ?? []) add(w);
    }
    for (const id of confused) add(this.byId.get(id));
    for (const id of preferred) add(this.byId.get(id));

    const tSyl = toneless(target).split(' ');
    const tNum = target.pinyinNumeric.trim().toLowerCase();
    const score = (w: Word): number => {
      let s = 0;
      const wc = [...w.headword];
      if (mode !== 'sound') {
        let vis = 0;
        for (let i = 0; i < len; i++) {
          if (wc[i] === chars[i]) vis += 0.5;
          else vis += charSimilarity(chars[i]!, wc[i]!);
        }
        // some position must actually look different-but-alike to count as a look-alike
        if (wc.some((c, i) => c !== chars[i] && charSimilarity(chars[i]!, c) > 0)) vis += 0.5;
        s += (vis / len) * 3;
        if (wc.some((c) => chars.includes(c))) s += 0.3;
      }
      if (mode !== 'visual') {
        const wNum = w.pinyinNumeric.trim().toLowerCase();
        const wSyl = toneless(w).split(' ');
        if (wNum === tNum) s += 3;
        else if (wSyl.join(' ') === tSyl.join(' ')) s += 2.5;
        else s += (wSyl.filter((x, i) => x === tSyl[i]).length / len) * 1.2;
      }
      if (confused.has(w.id)) s += 4;
      if (preferred.has(w.id)) s += 1;
      else if (w.source === 'supplement' || (w.source === 'tocfl' && w.level === null)) s -= 2;
      return s;
    };
    const tie = (w: Word) => parseInt(hashText(`${seed}|${target.id}|${w.id}`), 36) / 2 ** 32;
    const ranked = [...pool.values()]
      .filter((w) => !alsoCorrect(target, w))
      .map((w) => ({ w, s: score(w) + tie(w) * 0.2 }))
      .filter((x) => x.s > 0.6)
      .sort((a, b) => b.s - a.s);
    const out: Word[] = [];
    const usedHead = new Set([target.headword]);
    for (const { w } of ranked) {
      if (out.length >= n) break;
      if (usedHead.has(w.headword) || out.some((o) => alsoCorrect(o, w))) continue;
      usedHead.add(w.headword);
      out.push(w);
    }
    // Fallback: same-length words the learner knows, then any main word of that length.
    if (out.length < n) {
      const fill = [
        ...[...preferred].map((id) => this.byId.get(id)).filter((w): w is Word => !!w && [...w.headword].length === len),
        ...(this.byLength.get(len) ?? []).filter((w) => w.source === 'tocfl' && w.level !== null),
      ];
      const sorted = fill
        .map((w, i) => ({ w, k: i < preferred.size ? tie(w) : 1 + tie(w) }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.w);
      for (const w of sorted) {
        if (out.length >= n) break;
        if (usedHead.has(w.headword) || alsoCorrect(target, w) || out.some((o) => alsoCorrect(o, w))) continue;
        usedHead.add(w.headword);
        out.push(w);
      }
    }
    return out;
  }
}

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
