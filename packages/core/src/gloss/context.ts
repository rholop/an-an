import type { Sense, Word } from '../types.js';

/**
 * Deterministic, data-driven sense picking from the words next to a token —
 * the code-side fallback when the model gave no (or an invalid) sense id, and
 * what the reader uses on plain text (phase 7 §B4). It only ever picks among
 * the word's existing senses; it can't invent one.
 *
 * Rules are keyed on a sense's part of speech: a degree adverb right before
 * the word ("他很機車") points to an adjective (Vs) reading; a verb or measure
 * word that takes a thing ("騎機車", "一台機車") points to a noun reading.
 * Anything unclear falls back to the primary sense.
 */
const BEFORE_ADJECTIVE = new Set([
  '很',
  '太',
  '真',
  '好',
  '超',
  '有點',
  '非常',
  '比較',
  '最',
  '更',
  '那麼',
  '這麼',
  '多麼',
  '不',
]);
const BEFORE_NOUN = new Set([
  '騎',
  '搭',
  '坐',
  '開',
  '買',
  '停',
  '一台',
  '一輛',
  '那台',
  '這台',
  '我的',
  '你的',
  '他的',
  '新',
  '舊',
]);
const AFTER_NOUN = new Set(['的', '很快', '騎', '停']);
export interface SenseContext {
  /** Token immediately before / after (text), if any. */
  prev?: string;
  next?: string;
}

/** Sense POS follows the TOCFL tags: Vs (stative/adjectival), V, N, … */
const isAdjectival = (s: Sense) => (s.pos ?? '').split('/').some((p) => p === 'Vs' || p === 'Adj');
const isNominal = (s: Sense) => (s.pos ?? '').split('/').includes('N') || !s.pos;

export function pickSenseByContext(
  word: Pick<Word, 'senses' | 'primarySenseId'>,
  ctx: SenseContext = {},
): Sense | undefined {
  const senses = word.senses ?? [];
  if (senses.length === 0) return undefined;
  const primary = senses.find((s) => s.id === word.primarySenseId) ?? senses[0]!;
  if (senses.length === 1) return primary;

  if (ctx.prev && BEFORE_ADJECTIVE.has(ctx.prev)) {
    const adj = senses.find(isAdjectival);
    if (adj) return adj;
  }
  if ((ctx.prev && BEFORE_NOUN.has(ctx.prev)) || (ctx.next && AFTER_NOUN.has(ctx.next))) {
    if (isNominal(primary)) return primary;
    return senses.find(isNominal) ?? primary;
  }
  return primary;
}

/** The sense to show for a token: the model's pick if it is one of the word's
 * real sense ids, else the context rules, else the primary sense. */
export function resolveSense(
  word: Pick<Word, 'senses' | 'primarySenseId'>,
  modelSenseId: string | undefined,
  ctx: SenseContext = {},
): Sense | undefined {
  const byId = modelSenseId ? word.senses?.find((s) => s.id === modelSenseId) : undefined;
  return byId ?? pickSenseByContext(word, ctx);
}

const SOURCE_NAMES: Record<string, string> = {
  cedict: 'CC-CEDICT',
  'moe-cedict': 'CC-CEDICT (via MOE)',
  wiktionary: 'Wiktionary',
  top2011: 'TOCFL 2011 list',
  'moe-zh': 'MOE dictionary',
  supplement: "An'an",
  override: "An'an (edited)",
  ai: 'AI-generated',
};

/** The small source label under a definition: "CC-CEDICT · Taiwan". */
export function senseSourceLabel(sense: Pick<Sense, 'basedOn' | 'taiwanOnly'>): string {
  const names = [...new Set(sense.basedOn.map((s) => SOURCE_NAMES[s] ?? s))];
  return [names.join(' + '), sense.taiwanOnly ? 'Taiwan' : ''].filter(Boolean).join(' · ');
}
