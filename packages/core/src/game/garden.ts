import type { FSRS } from 'ts-fsrs';
import type { SkillCard } from '../learner/types.js';
import type { Lexicon } from '../lexicon.js';
import type { Scenario } from '../chat/scenario.js';
import type { Level, Word } from '../types.js';
import { isLevel, levelIndex, levelLabel, LEVEL_IDS } from '../levels.config.js';
import { isPracticeSkill, isReviewSkill, retrievabilityOf } from '../progress/terms.js';
import type { SessionName } from '../progress/review-sessions.js';
import type { Ledger } from '../progress/ledger.js';

/** Phase 21: the garden's stages ARE the shared terms: seed = New, sprout = learning, plant =
 * Learned, bloom = Mastered (`stageOf`). */
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

export { retrievabilityOf } from '../progress/terms.js';

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


export interface Plant {
  wordId: string;
  headword: string;
  /** seed = New, sprout = learning, plant = Learned, bloom = Mastered. */
  stage: GrowthStage;
  /** Learned but keeps lapsing: never blooms; shown with a small leech mark. */
  leech: boolean;
  /** Cards of this word in the current review session ("needs water", Phase 27). */
  dueCards: SkillCard[];
  /** Phase 27: not thirsty now, but a card is in the next session (a faint droplet outline). */
  nextSession?: SessionName;
  /** Lowest R across the word's skills (the weakest memory shows). */
  retrievability: number | null;
  wilt: Wilt;
  /** The cards behind this plant, for a focused review. */
  cards: SkillCard[];
}

/** The shared term for one word, as a garden stage. */
export function stageOf(ledger: Pick<Ledger, 'item'>, wordId: string): GrowthStage {
  const s = ledger.item({ kind: 'word', id: wordId }).status;
  return s === 'mastered' ? 'bloom' : s === 'learned' ? 'plant' : s === 'new' ? 'seed' : 'sprout';
}

/**
 * One plant per word, merging its cards. Its stage is the word's shared term (Phase 21); it "needs
 * water" when one of its cards is in the current review session (Phase 29 Part B.1:
 * `ledger.needsWater`, the same cards Home, Review, Water all and the badge count), and wilts
 * further the lower its weakest retrievability. Listening cards never make a plant thirsty.
 */
export function buildPlants(
  ledger: Pick<Ledger, 'metCards' | 'now' | 'item' | 'needsWater' | 'inNextSession' | 'status'>,
  lexicon: Lexicon,
  fsrsInstance: FSRS,
  config: GardenConfig = DEFAULT_GARDEN_CONFIG,
): Plant[] {
  const now = ledger.now;
  const byWord = new Map<string, SkillCard[]>();
  for (const c of ledger.metCards()) {
    if (c.item.kind !== 'word' || c.skill === 'listening') continue;
    const list = byWord.get(c.item.id) ?? [];
    list.push(c);
    byWord.set(c.item.id, list);
  }
  const nextName: SessionName = ledger.status.nextSession.name;
  const plants: Plant[] = [];
  for (const [wordId, wordCards] of byWord) {
    const word = lexicon.byId(wordId);
    if (!word) continue;
    const view = ledger.item({ kind: 'word', id: wordId });
    // The memory shown is the word's (practice skills such as Say it never wilt a plant).
    const rs = wordCards
      .filter((c) => !isPracticeSkill(c.skill))
      .map((c) => retrievabilityOf(c, now, fsrsInstance))
      .filter((r): r is number => r !== null);
    const retrievability = rs.length > 0 ? Math.min(...rs) : null;
    const reviewCards = wordCards.filter((c) => isReviewSkill(c.skill));
    const due = reviewCards.filter((c) => ledger.needsWater(c));
    const later = due.length === 0 && reviewCards.some((c) => ledger.inNextSession(c));
    const wilt: Wilt = due.length === 0 ? 'healthy' : wiltFor(retrievability, config) === 'withered' ? 'withered' : 'wilting';
    plants.push({
      wordId,
      headword: word.headword,
      stage: stageOf(ledger, wordId),
      leech: view.leech,
      dueCards: due,
      ...(later ? { nextSession: nextName } : {}),
      retrievability,
      wilt,
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
  /** Phase 27: plants whose cards are in the next session (no button: Review early waters them). */
  nextCount: number;
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
    const plot = plots.get(id) ?? { id, title, kind, plants: [], wiltingCount: 0, nextCount: 0 };
    plot.plants.push(plant);
    if (plant.wilt !== 'healthy') plot.wiltingCount++;
    else if (plant.nextSession) plot.nextCount++;
    plots.set(id, plot);
  };
  for (const p of plants) {
    const s = owner.get(p.wordId);
    if (s) add(`scenario:${s.id}`, s.title, 'scenario', p);
    else {
      const level: Level | null = (lexicon.byId(p.wordId) as Word | undefined)?.level ?? null;
      add(`level:${level ?? 'other'}`, level ? levelLabel(level) : 'Other words', 'level', p);
    }
  }
  // Scenario plots first (by title), then level plots in learning order (N1, N2, L1 …), "other" last.
  const levelRank = (p: Plot) => {
    const id = p.id.slice('level:'.length);
    return isLevel(id) ? levelIndex(id) : LEVEL_IDS.length;
  };
  return [...plots.values()].sort(
    (a, b) =>
      Number(a.kind === 'level') - Number(b.kind === 'level') ||
      (a.kind === 'level' ? levelRank(a) - levelRank(b) : a.title.localeCompare(b.title)),
  );
}

/** Cards to focus-review for a plot ("Water N words"): exactly its plants' cards in this session. */
export function wiltingCards(plot: Plot): SkillCard[] {
  return plot.plants.flatMap((p) => p.dueCards);
}
