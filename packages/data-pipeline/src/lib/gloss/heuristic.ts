import type { Sense, SenseCandidate } from '@anan/core';
import { condenseGloss, glossOverlap } from './normalize.js';
import type { SenseInventory } from './inventory.js';

const MAX_WORDS = 6;
const VERBISH = /^(V|Vs|Vi|Vp|Vt|VA|VAC|VC|VCL|VD|VE|VF|VG|VH|VI|VJ|VK|VL|Vaux|Vpt|Vst|Vi)$/;
const ADJ_CUE =
  /\b(annoying|difficult|hard to|troublesome|rude|good-looking|stylish|clever|stingy|lazy|cheap|expensive|noisy)\b/i;

export interface RankedCandidate {
  candidate: SenseCandidate;
  score: number;
}

function posBonus(gloss: string, tocflPos: string[]): number {
  const isTo = /^to\s/i.test(gloss);
  let bonus = 0;
  for (const pos of tocflPos) {
    if (VERBISH.test(pos)) bonus = Math.max(bonus, isTo ? 1.5 : pos === 'Vs' ? 0.4 : -0.5);
    else if (pos === 'N') bonus = Math.max(bonus, isTo ? -1 : 0.8);
    else if (pos === 'M' || pos === 'Msr')
      bonus = Math.max(bonus, /classifier|measure word|dozen|unit of/i.test(gloss) ? 2 : -0.2);
    else if (pos === 'Ptc')
      bonus = Math.max(
        bonus,
        /particle|marker|^used (to|after|before)|^\(used (to|after|before)/i.test(gloss) ? 2 : 0,
      );
    else bonus = Math.max(bonus, isTo ? -0.5 : 0.3); // Adv, Prep, Conj, Det, …
  }
  return bonus;
}

/**
 * Deterministic baseline ranking of the English candidates for one word
 * (no LLM): earlier CEDICT senses are more common, the old TOP gloss says
 * which sense the list meant, TOCFL's POS says what kind of gloss to expect,
 * Taiwan tags win, and non-meanings/mainland-only/literary senses sink.
 */
export function rankCandidates(inv: SenseInventory, tocflPos: string[]): RankedCandidate[] {
  const english = inv.candidates.filter(
    (c) =>
      c.glossEn &&
      c.source !== 'top2011' &&
      !(c.tags.includes('slang') && !c.tags.includes('taiwan')),
  );
  // Wiktionary lists rare and literal senses CEDICT leaves out, in no
  // frequency order: it fills gaps and adds Taiwan senses, but doesn't
  // outrank this reading's CEDICT senses (再見 "goodbye", not "to meet again").
  const hasCedict = english.some((c) => c.source === 'cedict' && !c.tags.includes('other-reading'));
  return english
    .map((candidate, i) => {
      const g = candidate.glossEn!;
      let score = -0.15 * i;
      const topOverlap = Math.max(0, ...inv.top2011.map((t) => glossOverlap(g, t)));
      score += 3 * topOverlap;
      score += posBonus(g, tocflPos);
      if (candidate.tags.includes('taiwan')) score += 1.5;
      if (candidate.tags.includes('informal')) score -= 0.6;
      if (candidate.tags.includes('literary') || candidate.tags.includes('technical')) score -= 2;
      if (candidate.tags.includes('mainland') && !candidate.tags.includes('taiwan')) score -= 3;
      if (candidate.tags.includes('loanword') && topOverlap === 0) score -= 1;
      if (candidate.tags.includes('reading-unverified')) score -= 0.3;
      if (candidate.source === 'wiktionary' && hasCedict) score -= 1.5;
      if (candidate.tags.includes('other-reading')) score -= 0.8;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);
}

export interface HeuristicResult {
  senses: Omit<Sense, 'id'>[];
  /** Why a human might want to look: 'no-source' | 'close-call'. */
  flags: string[];
}

function inferPos(gloss: string, tocflPos: string[], tags: string[]): string | undefined {
  if (/^to\s/i.test(gloss)) return tocflPos.find((p) => VERBISH.test(p) && p !== 'Vs') ?? 'V';
  if (ADJ_CUE.test(gloss) && !tags.includes('loanword')) return 'Vs';
  return tocflPos[0];
}

const clauses = (g: string) =>
  g
    .split(';')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
/** The `;`-clauses of `gloss` not already in `shown` (lower-cased), rejoined. */
const freshClauses = (gloss: string, shown: string[]) =>
  gloss
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !shown.includes(c.toLowerCase()))
    .join('; ');
const wordCount = (g: string) => g.split(/\s+/).filter(Boolean).length;
const isVerbGloss = (g: string) => /^to\s/i.test(g);

/** Primary sense + up to `maxSenses - 1` distinct alternatives, each condensed
 * to ≤ 6 words and citing its candidate's source (plus top2011 if it agrees).
 * CEDICT lists near-synonyms as separate glosses ("to beat/to strike/to hit"):
 * those that rank right behind the primary and are short are folded into it
 * ("to beat; to strike; to hit") instead of becoming separate "senses". */
export function heuristicSenses(
  inv: SenseInventory,
  tocflPos: string[],
  maxSenses = 4,
): HeuristicResult {
  const ranked = rankCandidates(inv, tocflPos);
  if (ranked.length === 0) return { senses: [], flags: ['no-source'] };

  const usable = ranked
    .map((r) => ({ ...r, gloss: condenseGloss(r.candidate.glossEn!) }))
    .filter((r) => r.gloss);
  const senses: Omit<Sense, 'id'>[] = [];
  const used = new Set<number>();
  const supports = (c: SenseCandidate) =>
    inv.top2011.some((t) => glossOverlap(c.glossEn!, t) > 0) ? ['top2011'] : [];

  const mk = (
    r: (typeof usable)[number],
    gloss: string,
    extraSources: string[],
  ): Omit<Sense, 'id'> => ({
    glossEn: gloss,
    pos: inferPos(r.candidate.glossEn!, tocflPos, r.candidate.tags),
    register: r.candidate.tags.includes('informal')
      ? 'informal'
      : r.candidate.tags.includes('literary')
        ? 'literary'
        : undefined,
    taiwanOnly: r.candidate.tags.includes('taiwan') || undefined,
    basedOn: [
      ...new Set([r.candidate.source as string, ...supports(r.candidate), ...extraSources]),
    ],
  });

  // Primary, then fold in close, short, same-kind neighbours.
  const first = usable[0]!;
  used.add(0);
  let primaryGloss = first.gloss;
  const primarySources: string[] = [];
  for (let i = 1; i < usable.length; i++) {
    const r = usable[i]!;
    if (first.score - r.score > 1.2) break;
    if (
      isVerbGloss(r.gloss) !== isVerbGloss(first.gloss) ||
      wordCount(r.gloss) > 3 ||
      /[!?]/.test(r.gloss)
    )
      continue;
    if (glossOverlap(primaryGloss, r.gloss) >= 0.8) {
      used.add(i);
      continue;
    }
    const add = freshClauses(r.gloss, clauses(primaryGloss));
    if (add === '') {
      used.add(i);
      continue;
    }
    if (wordCount(primaryGloss) + wordCount(add) > MAX_WORDS) continue;
    primaryGloss = `${primaryGloss}; ${add}`;
    primarySources.push(r.candidate.source as string);
    used.add(i);
  }
  senses.push(mk(first, primaryGloss, primarySources));

  for (let i = 1; i < usable.length && senses.length < maxSenses; i++) {
    if (used.has(i)) continue;
    const r = usable[i]!;
    if (senses.some((s) => glossOverlap(s.glossEn, r.gloss) >= 0.8)) continue;
    // Drop clauses an earlier sense already shows ("nearby; vicinity" after
    // "nearby; neighboring" -> "vicinity").
    const fresh = freshClauses(
      r.gloss,
      senses.flatMap((s) => clauses(s.glossEn)),
    );
    if (fresh === '') continue;
    senses.push(mk(r, fresh, []));
  }

  // A close call only matters when the top two disagree in KIND (a verb vs a
  // noun, a tagged vs untagged sense) — synonyms ("he"/"him") don't need a human.
  const flags: string[] = [];
  const second = usable.find((r, i) => i > 0 && !used.has(i));
  if (second && first.score - second.score < 0.5) {
    const kind = (r: typeof first) =>
      `${isVerbGloss(r.gloss)}|${r.candidate.tags.filter((t) => t === 'taiwan' || t === 'informal').join()}`;
    if (kind(first) !== kind(second)) flags.push('close-call');
  }
  return { senses, flags };
}
