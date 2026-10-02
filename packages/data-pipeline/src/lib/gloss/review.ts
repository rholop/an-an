import type { Level, Word } from '@anan/core';
import { LEVEL_IDS } from '@anan/core';
import type { GlossOrigin, ResolvedGloss } from './resolve.js';

export interface ReviewRow {
  word: Pick<Word, 'id' | 'headword' | 'pinyin' | 'level' | 'pos' | 'freqRank'>;
  gloss: ResolvedGloss;
  /** Alternatives the model/heuristic saw, for the reviewer. */
  topCandidates: string[];
}

export interface GlossStats {
  total: number;
  byOrigin: Record<GlossOrigin, number>;
  /** Share of N1–L2 words whose gloss cites at least one source. */
  earlySupportedShare: number;
  earlyTotal: number;
}

const EARLY: readonly Level[] = ['N1', 'N2', 'L1', 'L2'];

export const isSupported = (g: ResolvedGloss) =>
  g.origin !== 'none' && g.glossSources.length > 0 && !g.flags.includes('no-source');

export function computeStats(rows: readonly ReviewRow[]): GlossStats {
  const byOrigin: Record<GlossOrigin, number> = {
    override: 0,
    ai: 0,
    heuristic: 0,
    authored: 0,
    none: 0,
  };
  for (const r of rows) byOrigin[r.gloss.origin]++;
  const early = rows.filter((r) => r.word.level && EARLY.includes(r.word.level));
  const supported = early.filter((r) => isSupported(r.gloss)).length;
  return {
    total: rows.length,
    byOrigin,
    earlyTotal: early.length,
    earlySupportedShare: early.length === 0 ? 1 : supported / early.length,
  };
}

/** Needs a human: no source, low-confidence/rejected AI, or a close call. */
export const needsReview = (g: ResolvedGloss) =>
  g.origin !== 'override' && (g.flags.length > 0 || g.origin === 'none');

const order = (r: ReviewRow) => (r.word.level ? LEVEL_IDS.indexOf(r.word.level) : 99);

export function renderReview(
  rows: readonly ReviewRow[],
  stats: GlossStats,
  opts: { cap?: number } = {},
): string {
  const cap = opts.cap ?? 600;
  const flagged = rows
    .filter((r) => needsReview(r.gloss))
    .sort(
      (a, b) =>
        order(a) - order(b) || (a.word.freqRank ?? Infinity) - (b.word.freqRank ?? Infinity),
    );
  const lines: string[] = [
    '# Gloss review',
    '',
    'Words whose gloss a human should check. Put corrections in `data/supplement/gloss-overrides.yaml` (overrides always win and survive rebuilds).',
    '',
    `- ${stats.total} words: ${Object.entries(stats.byOrigin)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}.`,
    `- N1–L2 words with a cited source: ${(stats.earlySupportedShare * 100).toFixed(1)}% of ${stats.earlyTotal}.`,
    `- ${flagged.length} flagged${flagged.length > cap ? ` (first ${cap} shown, N1–L2 first)` : ''}.`,
    '',
    '| level | word | reading | shown gloss | origin | flags | other candidates |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const r of flagged.slice(0, cap)) {
    lines.push(
      `| ${r.word.level ?? '—'} | ${r.word.headword} | ${r.word.pinyin} | ${cell(r.gloss.glossEn || '—')} | ${r.gloss.origin} | ${r.gloss.flags.join(', ')} | ${cell(r.topCandidates.slice(0, 3).join(' · '))} |`,
    );
  }
  return lines.join('\n') + '\n';
}
