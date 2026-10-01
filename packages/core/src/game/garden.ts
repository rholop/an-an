import { State, type FSRS } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import type { Scenario } from '../chat/scenario.js';
import type { ItemState, Level, Word } from '../types.js';

export type GrowthStage = 'seed' | 'sprout' | 'plant' | 'bloom';
/** healthy: at/above target retention. wilting: below it. withered: far below. */
export type Wilt = 'healthy' | 'wilting' | 'withered';

export interface GardenConfig {
  /** FSRS target retention (default 0.9, user-configurable). */
  targetRetention: number;
  /** Retrievability this far below target counts as withered. */
  witheredMargin: number;
}

export const DEFAULT_GARDEN_CONFIG: GardenConfig = { targetRetention: 0.9, witheredMargin: 0.2 };

/** introduced -> learning -> review -> mature, as seed -> sprout -> plant -> bloom. */
export function growthStage(state: ItemState): GrowthStage | null {
  switch (state) {
    case 'unseen':
      return null;
    case 'introduced':
      return 'seed';
    case 'learning':
      return 'sprout';
    case 'review':
      return 'plant';
    case 'mature':
      return 'bloom';
  }
}

/** FSRS R(t) in [0,1], or null for a card that has never been reviewed (a
 * seed has no memory to decay yet, so it can't wilt). */
export function retrievabilityOf(card: SkillCard, now: Date, fsrsInstance: FSRS): number | null {
  if (card.card.state === State.New || card.card.reps === 0) return null;
  return fsrsInstance.get_retrievability(card.card, now, false);
}

/** The unit-tested R -> wilt mapping (phase doc acceptance criterion). */
export function wiltFor(
  retrievability: number | null,
  config: GardenConfig = DEFAULT_GARDEN_CONFIG,
): Wilt {
  if (retrievability === null) return 'healthy';
  if (retrievability >= config.targetRetention) return 'healthy';
  if (retrievability >= config.targetRetention - config.witheredMargin) return 'wilting';
  return 'withered';
}

const STAGE_ORDER: GrowthStage[] = ['seed', 'sprout', 'plant', 'bloom'];

export interface Plant {
  wordId: string;
  headword: string;
  stage: GrowthStage;
  /** Lowest R across the word's skills (the weakest memory shows). */
  retrievability: number | null;
  wilt: Wilt;
  /** The cards behind this plant, for a focused review. */
  cards: SkillCard[];
}

/** One plant per word, merging its recognition + production cards: it grows
 * to the *strongest* stage but wilts by the *weakest* retrievability. */
export function buildPlants(
  cards: readonly SkillCard[],
  lexicon: Lexicon,
  now: Date,
  fsrsInstance: FSRS,
  config: GardenConfig = DEFAULT_GARDEN_CONFIG,
): Plant[] {
  const byWord = new Map<string, SkillCard[]>();
  for (const c of cards) {
    if (c.item.kind !== 'word' || c.state === 'unseen') continue;
    const list = byWord.get(c.item.id) ?? [];
    list.push(c);
    byWord.set(c.item.id, list);
  }
  const plants: Plant[] = [];
  for (const [wordId, wordCards] of byWord) {
    const word = lexicon.byId(wordId);
    if (!word) continue;
    const stage = wordCards
      .map((c) => growthStage(c.state)!)
      .reduce((best, s) => (STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf(best) ? s : best));
    const rs = wordCards
      .map((c) => retrievabilityOf(c, now, fsrsInstance))
      .filter((r): r is number => r !== null);
    const retrievability = rs.length > 0 ? Math.min(...rs) : null;
    plants.push({
      wordId,
      headword: word.headword,
      stage,
      retrievability,
      wilt: wiltFor(retrievability, config),
      cards: wordCards,
    });
  }
  return plants.sort(
    (a, b) =>
      (a.retrievability ?? 1) - (b.retrievability ?? 1) || a.headword.localeCompare(b.headword),
  );
}

export interface Plot {
  id: string;
  title: string;
  kind: 'scenario' | 'level';
  plants: Plant[];
  wiltingCount: number;
}

/** Phase 6 §2: group plants into plots by scenario (a scenario's vocabExtras)
 * so the garden doubles as a map; everything else falls into a per-level plot.
 * A word belonging to several scenarios sits in the first one. */
export function groupPlots(
  plants: readonly Plant[],
  scenarios: readonly Scenario[],
  lexicon: Lexicon,
): Plot[] {
  const owner = new Map<string, Scenario>();
  for (const s of scenarios) {
    for (const headword of s.vocabExtras) {
      for (const w of lexicon.lookup(headword)) if (!owner.has(w.id)) owner.set(w.id, s);
    }
  }
  const plots = new Map<string, Plot>();
  const add = (id: string, title: string, kind: Plot['kind'], plant: Plant) => {
    const plot = plots.get(id) ?? { id, title, kind, plants: [], wiltingCount: 0 };
    plot.plants.push(plant);
    if (plant.wilt !== 'healthy') plot.wiltingCount++;
    plots.set(id, plot);
  };
  for (const p of plants) {
    const s = owner.get(p.wordId);
    if (s) add(`scenario:${s.id}`, s.title, 'scenario', p);
    else {
      const level: Level | null = (lexicon.byId(p.wordId) as Word | undefined)?.level ?? null;
      add(`level:${level ?? 'other'}`, level ? `Level ${level} words` : 'Other words', 'level', p);
    }
  }
  return [...plots.values()].sort(
    (a, b) =>
      Number(a.kind === 'level') - Number(b.kind === 'level') || a.title.localeCompare(b.title),
  );
}

/** Cards to focus-review for a plot: only plants that are wilting or withered. */
export function wiltingCards(plot: Plot): SkillCard[] {
  return plot.plants.filter((p) => p.wilt !== 'healthy').flatMap((p) => p.cards);
}
