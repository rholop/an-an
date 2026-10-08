import type { Lexicon } from '../lexicon.js';
import { segment } from '../segment.js';
import type { SentenceBankEntry } from '../cloze/sentence.js';
import type { GrammarItem } from '../types.js';

/**
 * Phase 25 Part B: the lesson grammar step, rebuilt.
 *
 * - Every grammar point of the lesson gets `perPoint` exercises (3), each on a DIFFERENT sentence,
 *   interleaved round-robin (A B C A B C A B C). Nothing is sliced off and nothing is deferred.
 * - "Siblings" here are exercises on the same sentence: they are never side by side.
 * - Four exercise types, chosen per point by what it can support, at least two types per point:
 *   fill the pattern (the blank comes from the grammar matcher's span), reorder (punctuation
 *   fixed, `altOrders` accepted), which sentence is right (`wrong` written in the content files),
 *   build it from English (tiles plus one distractor).
 * - A missed point comes back once at the end with a different sentence (`extraExercise`).
 */
export const GRAMMAR_STEP_CONFIG = {
  /** Exercises per grammar point in the lesson step. */
  perPoint: 3,
  /** A tile exercise needs at least this many movable tiles. */
  minTiles: 3,
  /** Fill-the-pattern options (answer + distractors). */
  fillOptions: 4,
} as const;

export type GrammarExerciseType = 'fill' | 'reorder' | 'pick' | 'build';

interface ExerciseBase {
  grammarId: string;
  sentenceId: string;
  zh: string;
  en?: string;
}

export interface FillExercise extends ExerciseBase {
  type: 'fill';
  before: string;
  answer: string;
  after: string;
  options: string[];
}

export interface TileExercise extends ExerciseBase {
  type: 'reorder' | 'build';
  /** The sentence's slots in order: a string is fixed punctuation, null is a place for a tile. */
  slots: Array<string | null>;
  /** The movable tiles, shuffled (a build exercise includes one distractor). */
  tiles: string[];
  distractor?: string;
  /** Every full sentence that counts as right (the sentence and its `altOrders`). */
  accepted: string[];
}

export interface PickExercise extends ExerciseBase {
  type: 'pick';
  options: [string, string];
  correctIndex: 0 | 1;
}

export type GrammarStepExercise = FillExercise | TileExercise | PickExercise;

/** A sentence the step can use (a bank entry, plus the Phase 25 content fields). */
export type GrammarSentence = Pick<SentenceBankEntry, 'id' | 'zh' | 'en' | 'grammarIds'> & {
  altOrders?: string[];
  wrong?: string;
};

type Rng = () => number;

function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Tiles

const PUNCT = /^[\s，。？！、；：「」『』（）,.?!;:"'()…—～~]+$/u;
const NUMBER_CHARS = '〇零一二兩三四五六七八九十百千萬幾半0123456789０１２３４５６７８９';
/** Measure words and time units a number takes as one tile (十一點, 三個, 五月, 二十塊). */
const NUMBER_UNITS = [
  '點', '號', '月', '日', '個', '歲', '塊', '本', '張', '天', '年', '分', '杯', '位', '次', '件', '條',
  '隻', '碗', '樓', '口', '雙', '種', '份', '支', '枝', '家', '間', '台', '臺', '輛', '頁', '課', '週',
  '刻', '元', '毛', '角', '公斤', '公尺', '公里', '分鐘', '小時', '星期', '樣', '題', '堂', '節', '片',
] as const;
const isNumberChar = (ch: string) => NUMBER_CHARS.includes(ch);

/**
 * The tiles of a reorder / build exercise. A number and its measure word or time unit are one tile
 * (十一點, 三個, 幾月); punctuation is its own token; the rest is matched over the words the learner
 * can know (`allowed`: a word outside it, such as 天才 in 每天才, is never a tile), taking the
 * segmentation with fewer tiles, then fewer single characters, then backward matching on a tie
 * (從/小時候, 請/進來, 從來/沒有, 一/下班).
 */
export function reorderTiles(zh: string, lexicon: Lexicon, allowed?: (headword: string) => boolean): string[] {
  const chars = [...zh];
  const out: string[] = [];
  let chunk: string[] = [];
  const flush = () => {
    if (chunk.length) out.push(...segmentChunk(chunk, lexicon, allowed));
    chunk = [];
  };
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (PUNCT.test(ch)) {
      flush();
      let j = i + 1;
      while (j < chars.length && PUNCT.test(chars[j]!)) j++;
      out.push(chars.slice(i, j).join(''));
      i = j;
      continue;
    }
    if (isNumberChar(ch)) {
      let j = i;
      while (j < chars.length && isNumberChar(chars[j]!)) j++;
      const rest = chars.slice(j).join('');
      const unit = UNITS_LONGEST_FIRST.find((u) => rest.startsWith(u));
      if (unit !== undefined || j - i >= 2 || /[0-9０-９]/.test(chars.slice(i, j).join(''))) {
        flush();
        const len = j - i + (unit ? [...unit].length : 0);
        out.push(chars.slice(i, i + len).join(''));
        i += len;
        continue;
      }
    }
    chunk.push(ch);
    i++;
  }
  flush();
  return out;
}

const UNITS_LONGEST_FIRST = [...NUMBER_UNITS].sort((a, b) => b.length - a.length);

function segmentChunk(chars: string[], lexicon: Lexicon, allowed?: (h: string) => boolean): string[] {
  const ok = (w: string) => lexicon.lookup(w).length > 0 && (!allowed || allowed(w));
  const max = Math.min(lexicon.maxHeadwordLength, chars.length);
  const fmm: string[] = [];
  for (let i = 0; i < chars.length; ) {
    let len = 1;
    for (let l = Math.min(max, chars.length - i); l > 1; l--)
      if (ok(chars.slice(i, i + l).join(''))) {
        len = l;
        break;
      }
    fmm.push(chars.slice(i, i + len).join(''));
    i += len;
  }
  const bmm: string[] = [];
  for (let e = chars.length; e > 0; ) {
    let len = 1;
    for (let l = Math.min(max, e); l > 1; l--)
      if (ok(chars.slice(e - l, e).join(''))) {
        len = l;
        break;
      }
    bmm.unshift(chars.slice(e - len, e).join(''));
    e -= len;
  }
  if (fmm.length !== bmm.length) return fmm.length < bmm.length ? fmm : bmm;
  const singles = (t: string[]) => t.filter((x) => [...x].length === 1).length;
  return singles(fmm) < singles(bmm) ? fmm : bmm;
}

export const isPunctTile = (t: string): boolean => PUNCT.test(t);

/** The slots (fixed punctuation / null) and movable tiles of a sentence. */
export function tileSlots(tiles: readonly string[]): { slots: Array<string | null>; movable: string[] } {
  return {
    slots: tiles.map((t) => (isPunctTile(t) ? t : null)),
    movable: tiles.filter((t) => !isPunctTile(t)),
  };
}

/** The sentence a learner built: the picked tiles in the open slots, punctuation where it is. */
export function fillSlots(slots: ReadonlyArray<string | null>, picked: readonly string[]): string {
  let k = 0;
  return slots.map((s) => (s === null ? (picked[k++] ?? '') : s)).join('');
}

const norm = (s: string) => s.replace(/\s+/g, '');

export function gradeTiles(ex: Pick<TileExercise, 'slots' | 'accepted'>, picked: readonly string[]): boolean {
  const built = norm(fillSlots(ex.slots, picked));
  return ex.accepted.some((a) => norm(a) === built);
}

// ---------------------------------------------------------------------------------------------
// Fill the pattern

/** Signal words that can both be right in the same blank (也 / 都): never each other's distractor. */
const INTERCHANGEABLE: ReadonlyArray<readonly string[]> = [['也', '都']];

function spansOf(zh: string, matcher: string | undefined): Array<[number, number]> {
  if (!matcher) return [[0, zh.length]];
  let re: RegExp;
  try {
    re = new RegExp(matcher, 'uy');
  } catch {
    return [[0, zh.length]];
  }
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < zh.length; i++) {
    re.lastIndex = i;
    const m = re.exec(zh);
    if (m && m[0].length > 0) spans.push([i, i + m[0].length]);
  }
  return spans;
}

/**
 * Where the blank goes: an occurrence of a focus word inside a span the grammar matcher matches,
 * preferring one that is its own word (not the 看 of 好看, the 是 of 不是, the 太 of 不太).
 */
export function patternBlank(
  zh: string,
  grammar: Pick<GrammarItem, 'focus' | 'matcher'>,
  lexicon?: Lexicon,
): { at: number; answer: string } | undefined {
  const focus = [...(grammar.focus ?? [])].sort((a, b) => b.length - a.length);
  if (focus.length === 0) return undefined;
  const spans = spansOf(zh, grammar.matcher);
  if (spans.length === 0) return undefined;
  const inSpan = (at: number, len: number) => spans.some(([s, e]) => at >= s && at + len <= e);
  const candidates: Array<{ at: number; answer: string; standalone: boolean }> = [];
  for (const f of focus)
    for (let at = zh.indexOf(f); at >= 0; at = zh.indexOf(f, at + 1))
      if (inSpan(at, f.length)) candidates.push({ at, answer: f, standalone: lexicon ? isStandalone(zh, at, f, lexicon) : true });
  candidates.sort((a, b) => Number(b.standalone) - Number(a.standalone) || a.at - b.at || b.answer.length - a.answer.length);
  const best = candidates[0];
  return best ? { at: best.at, answer: best.answer } : undefined;
}

/** Is `f` at `at` its own word in the sentence (not the 看 of 好看, the 是 of 不是, the 太 of 不太)? */
function isStandalone(zh: string, at: number, f: string, lexicon: Lexicon): boolean {
  return segment(zh, lexicon).some((t) => t.start === at && t.text === f);
}

export function buildFillExercise(
  s: GrammarSentence,
  g: Pick<GrammarItem, 'id' | 'focus' | 'matcher'>,
  pool: readonly string[],
  rng: Rng,
  lexicon?: Lexicon,
): FillExercise | undefined {
  const blank = patternBlank(s.zh, g, lexicon);
  if (!blank) return undefined;
  const { at, answer } = blank;
  const twins = new Set(INTERCHANGEABLE.filter((set) => set.includes(answer)).flat());
  const wrong = [...new Set(pool)].filter((w) => w !== answer && !twins.has(w) && !s.zh.includes(w));
  const ranked = shuffle(wrong, rng).sort(
    (a, b) => Math.abs([...a].length - [...answer].length) - Math.abs([...b].length - [...answer].length),
  );
  const options = shuffle([answer, ...ranked.slice(0, GRAMMAR_STEP_CONFIG.fillOptions - 1)], rng);
  if (options.length < 3) return undefined;
  return {
    type: 'fill',
    grammarId: g.id,
    sentenceId: s.id,
    zh: s.zh,
    en: s.en,
    before: s.zh.slice(0, at),
    answer,
    after: s.zh.slice(at + answer.length),
    options,
  };
}

export function buildTileExercise(
  type: 'reorder' | 'build',
  s: GrammarSentence,
  grammarId: string,
  tiles: readonly string[],
  rng: Rng,
  distractorPool: readonly string[] = [],
): TileExercise | undefined {
  const { slots, movable } = tileSlots(tiles);
  if (movable.length < GRAMMAR_STEP_CONFIG.minTiles) return undefined;
  let distractor: string | undefined;
  if (type === 'build') {
    distractor = shuffle(distractorPool, rng).find((w) => !s.zh.includes(w) && !movable.includes(w));
    if (!distractor) return undefined;
  }
  const accepted = [s.zh, ...(s.altOrders ?? [])];
  const pieces = distractor ? [...movable, distractor] : movable;
  let shuffled = shuffle(pieces, rng);
  // never hand over the answer already in order
  for (let k = 0; k < 4 && accepted.some((a) => norm(fillSlots(slots, shuffled)) === norm(a)); k++) shuffled = shuffle(pieces, rng);
  return { type, grammarId, sentenceId: s.id, zh: s.zh, en: s.en, slots, tiles: shuffled, ...(distractor ? { distractor } : {}), accepted };
}

export function buildPickExercise(s: GrammarSentence, grammarId: string, rng: Rng): PickExercise | undefined {
  if (!s.wrong || norm(s.wrong) === norm(s.zh)) return undefined;
  const first = rng() < 0.5;
  return {
    type: 'pick',
    grammarId,
    sentenceId: s.id,
    zh: s.zh,
    en: s.en,
    options: first ? [s.zh, s.wrong] : [s.wrong, s.zh],
    correctIndex: first ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------------------------
// The step

export interface GrammarStepInputs {
  /** The lesson's grammar point ids, in lesson order. */
  grammarIds: readonly string[];
  grammarItems: readonly Pick<GrammarItem, 'id' | 'focus' | 'matcher'>[];
  /** The lesson's usable sentences (reported ones already removed). */
  sentences: readonly GrammarSentence[];
  lexicon: Lexicon;
  /** Signal words of every point up to this lesson: fill distractors and the build distractor tile. */
  pool: readonly string[];
  /** Words the learner can know at this lesson (tiles never use a word outside it). */
  allowed?: (headword: string) => boolean;
  rng: Rng;
  perPoint?: number;
}

export interface GrammarStepPlan {
  exercises: GrammarStepExercise[];
  /** Per point: sentences not used yet (a miss comes back on one of these). */
  spares: Map<string, GrammarSentence[]>;
  /** Per point: every sentence tagged with it. */
  sentencesOf: Map<string, GrammarSentence[]>;
}

type Maker = (type: GrammarExerciseType, s: GrammarSentence) => GrammarStepExercise | undefined;

function makerFor(inputs: GrammarStepInputs, g: Pick<GrammarItem, 'id' | 'focus' | 'matcher'>): Maker {
  const { lexicon, rng, pool, allowed } = inputs;
  return (type, s) => {
    switch (type) {
      case 'fill':
        return buildFillExercise(s, g, pool, rng, lexicon);
      case 'pick':
        return buildPickExercise(s, g.id, rng);
      default:
        return buildTileExercise(type, s, g.id, reorderTiles(s.zh, lexicon, allowed), rng, pool);
    }
  };
}

/** The type order a point prefers: points with a signal word start with Fill, the rest with Reorder. */
function preferredTypes(g: Pick<GrammarItem, 'focus'>): GrammarExerciseType[] {
  return (g.focus ?? []).length > 0 ? ['fill', 'pick', 'build', 'reorder'] : ['reorder', 'pick', 'build', 'fill'];
}

export function buildGrammarStep(inputs: GrammarStepInputs): GrammarStepPlan {
  const perPoint = inputs.perPoint ?? GRAMMAR_STEP_CONFIG.perPoint;
  const byId = new Map(inputs.grammarItems.map((g) => [g.id, g]));
  const usedAnywhere = new Set<string>();
  const perPointLists: GrammarStepExercise[][] = [];
  const spares = new Map<string, GrammarSentence[]>();
  const sentencesOf = new Map<string, GrammarSentence[]>();
  for (const gid of inputs.grammarIds) {
    const g = byId.get(gid);
    if (!g) continue;
    const tagged = inputs.sentences.filter((s) => s.grammarIds?.includes(gid));
    sentencesOf.set(gid, tagged);
    // sentences no other point has used yet come first
    const candidates = shuffle(tagged, inputs.rng).sort((a, b) => Number(usedAnywhere.has(a.id)) - Number(usedAnywhere.has(b.id)));
    const make = makerFor(inputs, g);
    const prefs = preferredTypes(g);
    const chosen: GrammarStepExercise[] = [];
    const used = new Set<string>();
    for (let k = 0; k < perPoint; k++) {
      // rotate the preference so the three exercises try different types
      const order = [...prefs.slice(k % prefs.length), ...prefs.slice(0, k % prefs.length)];
      const typesSoFar = new Set(chosen.map((e) => e.type));
      // a type not used yet for this point first
      order.sort((a, b) => Number(typesSoFar.has(a)) - Number(typesSoFar.has(b)));
      let made: GrammarStepExercise | undefined;
      for (const t of order) {
        for (const s of candidates) {
          if (used.has(s.id)) continue;
          made = make(t, s);
          if (made) break;
        }
        if (made) break;
      }
      if (!made) break;
      used.add(made.sentenceId);
      usedAnywhere.add(made.sentenceId);
      chosen.push(made);
    }
    perPointLists.push(chosen);
    spares.set(gid, candidates.filter((s) => !used.has(s.id)));
  }
  // round-robin: A B C A B C A B C
  const exercises: GrammarStepExercise[] = [];
  const rounds = Math.max(0, ...perPointLists.map((l) => l.length));
  for (let r = 0; r < rounds; r++) for (const l of perPointLists) if (l[r]) exercises.push(l[r]!);
  return { exercises: separateSameSentence(exercises), spares, sentencesOf };
}

/** Two exercises on the same sentence (a sentence tagged with two points) are never side by side. */
function separateSameSentence(list: GrammarStepExercise[]): GrammarStepExercise[] {
  const out = [...list];
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.sentenceId !== out[i - 1]!.sentenceId) continue;
    const j = out.findIndex(
      (e, k) => k > i && e.sentenceId !== out[i - 1]!.sentenceId && (k + 1 >= out.length || out[k + 1]!.sentenceId !== out[i]!.sentenceId),
    );
    if (j > i) [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The extra exercise after a miss: the same point on a DIFFERENT sentence (a spare first, then any
 * other sentence of the point), never the identical question. `taken` = sentence ids already shown.
 */
export function extraExercise(
  plan: GrammarStepPlan,
  missed: GrammarStepExercise,
  inputs: GrammarStepInputs,
  taken: ReadonlySet<string> = new Set(),
): GrammarStepExercise | undefined {
  const g = inputs.grammarItems.find((x) => x.id === missed.grammarId);
  if (!g) return undefined;
  const make = makerFor(inputs, g);
  const spare = (plan.spares.get(g.id) ?? []).filter((s) => !taken.has(s.id));
  const others = (plan.sentencesOf.get(g.id) ?? []).filter((s) => s.id !== missed.sentenceId && !spare.includes(s));
  const types: GrammarExerciseType[] = [missed.type, ...preferredTypes(g).filter((t) => t !== missed.type)];
  for (const pool of [spare, others])
    for (const s of pool)
      for (const t of types) {
        const e = make(t, s);
        if (e) return e;
      }
  return undefined;
}

/** Answer-checking for any exercise (`answer` = option index, picked tiles, or the option text). */
export function checkGrammarAnswer(ex: GrammarStepExercise, answer: number | string | readonly string[]): boolean {
  switch (ex.type) {
    case 'fill':
      return answer === ex.answer;
    case 'pick':
      return answer === ex.correctIndex;
    default:
      return Array.isArray(answer) && gradeTiles(ex, answer as string[]);
  }
}
