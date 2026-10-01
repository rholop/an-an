import type { Lexicon } from '../lexicon.js';
import type { Word } from '../types.js';

export interface DistractorOptions {
  count: number;
  /** Prioritize shared-character or same-POS words over a plain random
   * same-level pick (phase doc §3 rung 2: "confusable distractors (same
   * level, shared character, similar meaning or same POS)"). */
  preferConfusable?: boolean;
}

function sameLevelPool(target: Word, lexicon: Lexicon): Word[] {
  return lexicon.allWords().filter((w) => w.id !== target.id && w.level === target.level);
}

function sharesCharacter(a: Word, b: Word): boolean {
  return a.chars.some((c) => b.chars.includes(c));
}

function samePos(a: Word, b: Word): boolean {
  return a.pos.some((p) => b.pos.includes(p));
}

/**
 * True if `candidate` would also correctly complete a blank meant for
 * `target` — either literally the same lexical item (a variant spelling)
 * or a near-synonym (same English gloss). Phase 4's acceptance criterion
 * ("distractors never include a correct alternative answer") is this
 * function failing to exclude something it should have.
 */
function isCorrectAlternative(target: Word, candidate: Word): boolean {
  if (candidate.headword === target.headword) return true;
  if (target.variants.includes(candidate.headword) || candidate.variants.includes(target.headword)) return true;
  if (candidate.glossEn && candidate.glossEn === target.glossEn) return true;
  return false;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Selects up to `count` distractor words for a multiple-choice/word-bank
 * cloze item. Never returns the target itself, a spelling variant of it, or
 * a same-gloss synonym (see isCorrectAlternative). May return fewer than
 * `count` if the lexicon doesn't have enough eligible same-level words —
 * callers should fall back to a different exercise type rather than pad
 * with an out-of-level or cross-answer option.
 */
export function pickDistractors(
  target: Word,
  lexicon: Lexicon,
  options: DistractorOptions,
  rng: () => number = Math.random,
): Word[] {
  const pool = sameLevelPool(target, lexicon).filter((w) => !isCorrectAlternative(target, w));
  if (pool.length === 0) return [];

  if (!options.preferConfusable) {
    return shuffle(pool, rng).slice(0, options.count);
  }

  const confusable = pool.filter((w) => sharesCharacter(w, target) || samePos(w, target));
  const confusableIds = new Set(confusable.map((w) => w.id));
  const rest = pool.filter((w) => !confusableIds.has(w.id));
  return [...shuffle(confusable, rng), ...shuffle(rest, rng)].slice(0, options.count);
}
