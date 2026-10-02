import type { GlossAdjudicationRequest, Sense, Word } from '@anan/core';
import { validateAdjudication, type AdjudicationRecord } from './adjudicate.js';
import { heuristicSenses } from './heuristic.js';
import type { SenseInventory } from './inventory.js';
import { findOverride, type GlossOverride } from './overrides.js';
import { condenseGloss, parseGloss, pinyinKey, splitOutsideParens } from './normalize.js';

export type GlossOrigin = 'override' | 'ai' | 'heuristic' | 'authored' | 'none';

export interface ResolvedGloss {
  senses: Sense[];
  primarySenseId: string | undefined;
  glossEn: string;
  glossSources: string[];
  origin: GlossOrigin;
  /** Why a human should look (→ gloss-review.md). */
  flags: string[];
}

export interface ResolveInput {
  word: Pick<Word, 'id' | 'headword' | 'pinyin' | 'pos' | 'glossEn'> & { source: Word['source'] };
  inventory: SenseInventory;
  /** The stored model response for this word, if the batch has run. */
  adjudication?: AdjudicationRecord;
  request?: GlossAdjudicationRequest;
  overrides: readonly GlossOverride[];
}

const withIds = (wordId: string, senses: Omit<Sense, 'id'>[]): Sense[] =>
  senses.map((s, i) => ({ ...s, id: `${wordId}#${i + 1}` }));

/**
 * Precedence (phase doc B2): hand OVERRIDE  >  validated AI adjudication  >
 * deterministic heuristic over the source candidates  >  an authored
 * supplement gloss  >  nothing. An override always wins and survives
 * rebuilds because it lives in data/supplement/gloss-overrides.yaml.
 */
export function resolveGloss(input: ResolveInput): ResolvedGloss {
  const { word } = input;

  const override = findOverride(input.overrides, word, pinyinKey);
  if (override) {
    const senses = withIds(
      word.id,
      override.senses.map((s) => ({ ...s, basedOn: ['override'] })),
    );
    return {
      senses,
      primarySenseId: senses[0]!.id,
      glossEn: senses[0]!.glossEn,
      glossSources: ['override'],
      origin: 'override',
      flags: [],
    };
  }

  if (input.adjudication?.response !== undefined && input.request) {
    const verdict = validateAdjudication(input.adjudication.response, input.request);
    if (verdict.ok) {
      const senses = withIds(word.id, verdict.value.senses);
      const primary = senses[verdict.value.primaryIndex]!;
      return {
        senses,
        primarySenseId: primary.id,
        glossEn: primary.glossEn,
        glossSources: primary.basedOn,
        origin: 'ai',
        flags: verdict.value.flags,
      };
    }
    // fall through to the heuristic, but make the rejection visible
    const h = heuristicResult(input);
    return { ...h, flags: [...h.flags, 'ai-rejected'] };
  }

  return heuristicResult(input);
}

/** A hand-authored supplement gloss ("scooter/motorbike; (slang, Vs) annoying")
 * -> senses. `;` separates senses; a leading "(…, Vs)" marker carries the POS
 * and register. */
export function sensesFromAuthored(
  gloss: string,
  defaultPos: string | undefined,
): Omit<Sense, 'id'>[] {
  return splitOutsideParens(gloss, ';').map((part) => {
    const m = /^\(([^)]*)\)\s*(.*)$/.exec(part);
    const markers = m ? m[1]!.split(',').map((x) => x.trim()) : [];
    const pos = markers.find((x) => /^(N|V|Vs|Adv|Prep|Conj|Ptc|M|Det)$/.test(x));
    const register = markers.find((x) => /^(slang|colloquial|literary|vulgar)$/i.test(x));
    return {
      glossEn: (m && (pos || register) ? m[2]! : part).replace(/^[,\s]+|[,\s]+$/g, ''),
      pos: pos ?? defaultPos,
      register: register?.toLowerCase(),
      basedOn: ['supplement'],
    };
  });
}

function heuristicResult(input: ResolveInput): ResolvedGloss {
  const { word, inventory } = input;
  if (word.source === 'supplement' && word.glossEn) {
    const senses = withIds(word.id, sensesFromAuthored(word.glossEn, word.pos[0]));
    return {
      senses,
      primarySenseId: senses[0]!.id,
      glossEn: senses[0]!.glossEn,
      glossSources: ['supplement'],
      origin: 'authored',
      flags: [],
    };
  }
  const h = heuristicSenses(inventory, word.pos);
  if (h.senses.length > 0) {
    const senses = withIds(word.id, h.senses);
    return {
      senses,
      primarySenseId: senses[0]!.id,
      glossEn: senses[0]!.glossEn,
      glossSources: senses[0]!.basedOn,
      origin: 'heuristic',
      flags: h.flags,
    };
  }
  if (word.glossEn) {
    const authored =
      word.source === 'supplement'
        ? word.glossEn
        : condenseGloss(parseGloss(word.glossEn).text) || word.glossEn;
    // Supplement entries carry a hand-authored gloss (names, particles, Taiwan terms).
    const senses = withIds(word.id, [
      {
        glossEn: authored,
        basedOn: [word.source === 'supplement' ? 'supplement' : 'moe-cedict'],
        pos: word.pos[0],
      },
    ]);
    return {
      senses,
      primarySenseId: senses[0]!.id,
      glossEn: authored,
      glossSources: senses[0]!.basedOn,
      origin: 'authored',
      flags: word.source === 'supplement' ? [] : ['no-source'],
    };
  }
  return {
    senses: [],
    primarySenseId: undefined,
    glossEn: '',
    glossSources: [],
    origin: 'none',
    flags: ['no-source'],
  };
}
