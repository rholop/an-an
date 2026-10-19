// Phase 48 Part A: building the offline candidate table (`pnpm build:distractors`) and checking the
// optional Gemini suggestions. Pure: the pipeline script reads and writes the files.

import { levelIndex } from '../levels.config.js';
import { isSimplifiedOnly } from '../taiwanness.js';
import type { Word } from '../types.js';
import { alsoCorrect, ConfusableIndex } from './index.js';
import { DISTRACTOR_TABLE_SIZE, type DistractorTable, type TableAxis } from './table.js';

/** Checked Gemini suggestions (`data/build/distractor-suggestions.v1.json`): headwords per word id,
 * with the model that suggested them. Only suggestions that passed `checkSuggestion` are kept. */
export interface DistractorSuggestions {
  version: 1;
  words: Record<string, { model: string; headwords: string[] }>;
}

/** Words that get a table entry: TOCFL N1–L3, textbook words (with lesson extras) and custom words. */
export function isStudyableForDistractors(w: Word): boolean {
  if (w.tags.includes('name') || w.tags.includes('proper-noun')) return false;
  if (w.source === 'textbook' || w.source === 'custom') return true;
  if (w.tags.some((t) => t.startsWith('textbook:'))) return true;
  return w.source === 'tocfl' && w.level !== null && levelIndex(w.level) <= levelIndex('L3');
}

/**
 * Why a suggested headword can't be a distractor for `target` (undefined = it can): it must be in
 * the lexicon, the same length, traditional characters only, not also correct, and not a name.
 */
export function checkSuggestion(target: Word, headword: string, byHeadword: ReadonlyMap<string, Word>): string | undefined {
  const w = byHeadword.get(headword);
  if (!w) return 'not in the lexicon';
  if ([...headword].length !== [...target.headword].length) return 'another length';
  if ([...headword].some(isSimplifiedOnly)) return 'simplified characters';
  if (w.tags.includes('name') || w.tags.includes('proper-noun')) return 'a name';
  if (w.id === target.id || alsoCorrect(target, w)) return 'also correct';
  return undefined;
}

const AXIS_ORDER: TableAxis[] = ['char', 'shape', 'sound', 'meaning', 'suggest'];

/** The table for `words` (every word in the lexicon is a possible candidate; entries only for
 * studyable words). Candidates near the word's own level first, mixing axes. Deterministic. */
export function buildDistractorTable(
  words: readonly Word[],
  opts: { suggestions?: DistractorSuggestions; studyable?: (w: Word) => boolean; size?: number } = {},
): DistractorTable {
  const index = new ConfusableIndex(words);
  const byHeadword = new Map<string, Word>();
  for (const w of words) if (w.source !== 'supplement' && !byHeadword.has(w.headword)) byHeadword.set(w.headword, w);
  const size = opts.size ?? DISTRACTOR_TABLE_SIZE;
  const studyable = opts.studyable ?? isStudyableForDistractors;
  const out: DistractorTable = { version: 1, words: {} };
  for (const target of words) {
    if (!studyable(target)) continue;
    const own = target.level ? levelIndex(target.level) : 2;
    const entries = new Map<string, { w: Word; axes: Set<TableAxis> }>();
    const usable = (w: Word) => w.source !== 'supplement' && w.level !== null;
    for (const c of index.candidates(target))
      if (usable(c.word)) entries.set(c.word.id, { w: c.word, axes: new Set([...c.axes].filter((a) => a !== 'confused') as TableAxis[]) });
    for (const h of opts.suggestions?.words[target.id]?.headwords ?? []) {
      if (checkSuggestion(target, h, byHeadword)) continue;
      const w = byHeadword.get(h)!;
      const e = entries.get(w.id) ?? { w, axes: new Set<TableAxis>() };
      e.axes.add('suggest');
      entries.set(w.id, e);
    }
    const score = (e: { w: Word; axes: Set<TableAxis> }) => {
      const lv = e.w.level ? levelIndex(e.w.level) : 6;
      return e.axes.size * 2 + (e.axes.has('char') ? 1 : 0) - Math.max(0, lv - own) * 1.5 - Math.max(0, own - lv) * 0.2;
    };
    const ranked = [...entries.values()].sort((a, b) => score(b) - score(a) || (a.w.id < b.w.id ? -1 : 1));
    const picked: typeof ranked = [];
    // every axis first (so the table keeps a meaning neighbour even when look-alikes score higher)
    for (const axis of AXIS_ORDER) {
      const e = ranked.find((x) => x.axes.has(axis) && !picked.includes(x));
      if (e && picked.length < size) picked.push(e);
    }
    for (const e of ranked) {
      if (picked.length >= size) break;
      if (!picked.includes(e)) picked.push(e);
    }
    if (picked.length > 0)
      out.words[target.id] = picked
        .sort((a, b) => score(b) - score(a) || (a.w.id < b.w.id ? -1 : 1))
        .map((e) => [e.w.id, AXIS_ORDER.filter((a) => e.axes.has(a)).join('+')]);
  }
  return out;
}
