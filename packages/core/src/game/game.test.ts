import { describe, expect, it } from 'vitest';
import { buildFsrs } from '../learner/fsrs-instance.js';
import { emptyCard } from '../learner/fsrs-instance.js';
import { DEFAULT_LEARNER_CONFIG, type SkillCard } from '../learner/types.js';
import { applyEvidence } from '../learner/apply-evidence.js';
import type { Scenario } from '../chat/scenario.js';
import { buildFixtureLexicon } from '../test-fixtures/lexicon-fixture.js';
import type { Evidence } from '../types.js';
import { analyzeText } from '../validate/turn.js';
import {
  buildPlants,
  groupPlots,
  growthStage,
  retrievabilityOf,
  wiltFor,
  wiltingCards,
} from './garden.js';
import { actualRetention, scenarioMetrics } from './metrics.js';
import { REWARD_TABLE, rewardsForEvidence, makeReward, totalPoints, dayKey } from './rewards.js';
import {
  bestStars,
  buildScenarioMap,
  coverageContext,
  isScenarioAvailable,
  scenarioCorpus,
  scenarioCoverage,
  starsFor,
  type ConversationRecord,
} from './scenario-progress.js';
import { computeStreak, weeklySummary } from './streak.js';

const lexicon = buildFixtureLexicon();
const fsrs = buildFsrs(DEFAULT_LEARNER_CONFIG);
const day = (n: number, h = 12) => new Date(2026, 2, n, h);

function reviewed(wordHeadword: string, reviewedAt: Date, grades = 1): SkillCard {
  const word = lexicon.lookup(wordHeadword)[0]!;
  let card: SkillCard | undefined;
  for (let i = 0; i < grades; i++) {
    const ev: Evidence = {
      item: { kind: 'word', id: word.id },
      skill: 'recognition',
      kind: 'review_good',
      at: reviewedAt,
    };
    card = applyEvidence(card, ev, reviewedAt).card;
  }
  return card!;
}

describe('reward table', () => {
  it('only rewards learning behaviours: nothing for time, opening, or logging in', () => {
    for (const [kind, rule] of Object.entries(REWARD_TABLE)) {
      expect(kind).not.toMatch(/time|open|login|visit|session|minute|daily|usage/i);
      expect(rule.behaviour.length).toBeGreaterThan(10);
      expect(rule.points).toBeGreaterThan(0);
    }
    expect(Object.keys(REWARD_TABLE).sort()).toEqual(
      [
        'error_fixed',
        'journal_entry',
        'recall_correct',
        'recall_hinted',
        'scenario_completed',
        'scenario_unassisted',
        'self_correction',
        'word_revived',
      ].sort(),
    );
  });

  const ev = (kind: Evidence['kind'], at = day(10)): Evidence => ({
    item: { kind: 'word', id: 'w' },
    skill: 'recognition',
    kind,
    at,
  });

  it('pays for successful recalls, and only those', () => {
    expect(rewardsForEvidence(ev('cloze_correct_nohint'), undefined).map((r) => r.kind)).toEqual([
      'recall_correct',
    ]);
    expect(rewardsForEvidence(ev('review_good'), undefined).map((r) => r.kind)).toEqual([
      'recall_correct',
    ]);
    expect(rewardsForEvidence(ev('cloze_correct_hint'), undefined).map((r) => r.kind)).toEqual([
      'recall_hinted',
    ]);
    for (const k of [
      'review_again',
      'cloze_wrong',
      'chat_read_no_lookup',
      'chat_lookup_gloss',
      'chat_hover_reading',
      'anki_import_seen',
      'placement_known',
      'journal_misuse',
    ] as const) {
      expect(rewardsForEvidence(ev(k), undefined)).toEqual([]);
    }
  });

  it('adds a revive bonus when the recalled word was a week overdue', () => {
    const card = reviewed('我', day(1));
    const late = rewardsForEvidence(
      ev('review_good', new Date(card.card.due.getTime() + 8 * 86_400_000)),
      card,
    );
    expect(late.map((r) => r.kind)).toEqual(['word_revived', 'recall_correct']);
    const onTime = rewardsForEvidence(
      ev('review_good', new Date(card.card.due.getTime() + 86_400_000)),
      card,
    );
    expect(onTime.map((r) => r.kind)).toEqual(['recall_correct']);
  });

  it('ids dedupe the same behaviour on the same day', () => {
    expect(makeReward('journal_entry', day(3, 9), 'e1').id).toBe(
      makeReward('journal_entry', day(3, 20), 'e1').id,
    );
    expect(makeReward('journal_entry', day(3), 'e1').id).not.toBe(
      makeReward('journal_entry', day(4), 'e1').id,
    );
    expect(
      totalPoints([
        makeReward('journal_entry', day(3), 'a'),
        makeReward('error_fixed', day(3), 'b'),
      ]),
    ).toBe(11);
  });
});

describe('garden', () => {
  it('maps item state to growth stage', () => {
    expect(
      ['unseen', 'introduced', 'learning', 'review', 'mature'].map((s) => growthStage(s as never)),
    ).toEqual([null, 'seed', 'sprout', 'plant', 'bloom']);
  });

  it('wiltFor: healthy at/above target, wilting below, withered far below (table)', () => {
    const cases: [number | null, string][] = [
      [null, 'healthy'], // never reviewed: a seed can't wilt
      [1, 'healthy'],
      [0.9, 'healthy'],
      [0.8999, 'wilting'],
      [0.75, 'wilting'],
      [0.7, 'wilting'],
      [0.6999, 'withered'],
      [0.2, 'withered'],
    ];
    for (const [r, wilt] of cases) expect(wiltFor(r)).toBe(wilt);
    expect(wiltFor(0.85, { targetRetention: 0.85, witheredMargin: 0.2 })).toBe('healthy');
    expect(wiltFor(0.84, { targetRetention: 0.85, witheredMargin: 0.2 })).toBe('wilting');
  });

  it('retrievability falls with time and drives the wilt of a real FSRS card', () => {
    const card = reviewed('我', day(1), 3);
    const fresh = retrievabilityOf(card, card.card.last_review!, fsrs)!;
    const due = retrievabilityOf(card, card.card.due, fsrs)!;
    const later = retrievabilityOf(
      card,
      new Date(card.card.due.getTime() + 60 * 86_400_000),
      fsrs,
    )!;
    expect(fresh).toBeGreaterThan(due);
    expect(due).toBeGreaterThan(later);
    expect(wiltFor(fresh)).toBe('healthy');
    expect(wiltFor(later)).toBe('withered');
    const introduced = { ...card, card: emptyCard(day(1)), state: 'introduced' as const };
    expect(retrievabilityOf(introduced, day(40), fsrs)).toBeNull();
  });

  it('a plant grows by its strongest card and wilts by its weakest', () => {
    const rec = reviewed('我', day(1), 3);
    const wordId = rec.item.id;
    const prod: SkillCard = { ...reviewed('我', day(1)), skill: 'production' };
    const plants = buildPlants(
      [rec, prod],
      lexicon,
      new Date(rec.card.due.getTime() + 30 * 86_400_000),
      fsrs,
    );
    expect(plants).toHaveLength(1);
    expect(plants[0]).toMatchObject({
      wordId,
      stage: growthStage(rec.state) === 'bloom' ? 'bloom' : growthStage(rec.state),
    });
    expect(plants[0]!.wilt).not.toBe('healthy');
    expect(plants[0]!.retrievability).toBe(
      Math.min(
        retrievabilityOf(rec, new Date(rec.card.due.getTime() + 30 * 86_400_000), fsrs)!,
        retrievabilityOf(prod, new Date(rec.card.due.getTime() + 30 * 86_400_000), fsrs)!,
      ),
    );
  });

  const scenario = (id: string, extras: string[]): Scenario => ({
    id,
    title: `Scenario ${id}`,
    levelRange: { min: 'N1', max: 'L2' },
    npc: { id: 'n', name: '店員', personality: 'p', speechStyle: 's', particles: [] },
    setting: 's',
    goalSteps: [{ id: 'g', description: 'd', keywordHints: ['咖啡'] }],
    vocabExtras: extras,
    opener: { zh: '你好！', en: 'Hi' },
    successLine: { zh: '謝謝！', en: 'Thanks' },
  });

  it('groups plants into scenario plots plus level plots, and lists wilting cards for focus review', () => {
    const later = new Date(2026, 6, 1);
    const cards = ['咖啡', '我', '捷運'].map((hw) => reviewed(hw, day(1)));
    const plants = buildPlants(cards, lexicon, later, fsrs);
    const plots = groupPlots(plants, [scenario('cafe', ['咖啡', '捷運'])], lexicon);
    expect(plots.map((p) => p.id)).toEqual(['scenario:cafe', 'level:other']);
    expect(plots[0]!.plants.map((p) => p.headword).sort()).toEqual(['咖啡', '捷運']);
    expect(plots[0]!.wiltingCount).toBe(2);
    expect(wiltingCards(plots[0]!)).toHaveLength(2);
    const healthy = buildPlants(cards, lexicon, day(1, 13), fsrs);
    expect(wiltingCards(groupPlots(healthy, [], lexicon)[0]!)).toEqual([]);
  });
});

describe('scenario progress', () => {
  const rec = (over: Partial<ConversationRecord> = {}): ConversationRecord => ({
    scenarioId: 'a',
    startedAt: day(1, 10),
    endedAt: new Date(day(1, 10).getTime() + 90_000),
    completed: true,
    stuckCount: 0,
    englishFallbackUsed: false,
    ...over,
  });

  it('awards stars: completed, no stuck, no English — only on completion', () => {
    expect(starsFor(rec()).count).toBe(3);
    expect(starsFor(rec({ stuckCount: 2 })).count).toBe(2);
    expect(starsFor(rec({ englishFallbackUsed: true })).count).toBe(2);
    expect(starsFor(rec({ stuckCount: 1, englishFallbackUsed: true })).count).toBe(1);
    expect(starsFor(rec({ completed: false })).count).toBe(0);
  });

  it('keeps the best of each criterion across attempts', () => {
    const s = bestStars([rec({ stuckCount: 3 }), rec({ englishFallbackUsed: true })]);
    expect(s).toMatchObject({ completed: true, noStuck: true, noEnglish: true, count: 3 });
  });

  it('unlocks from the frontier and stays unlocked', () => {
    const s = { ...scenario0(), levelRange: { min: 'L1' as const, max: 'L2' as const } };
    expect(isScenarioAvailable(s, 'N2')).toBe(false);
    expect(isScenarioAvailable(s, 'L1')).toBe(true);
    expect(isScenarioAvailable(s, 'L4')).toBe(true); // past its max: still replayable
  });

  it('builds a level-sorted map with stars, attempts and best unassisted time', () => {
    const a = {
      ...scenario0(),
      id: 'a',
      title: 'A',
      levelRange: { min: 'L1' as const, max: 'L3' as const },
    };
    const b = {
      ...scenario0(),
      id: 'b',
      title: 'B',
      levelRange: { min: 'N1' as const, max: 'L2' as const },
    };
    const map = buildScenarioMap([a, b], 'N2', [
      rec(),
      rec({ endedAt: new Date(day(1, 10).getTime() + 30_000) }),
      rec({ scenarioId: 'zzz' }),
    ]);
    expect(
      map.map((n) => [n.scenario.id, n.unlocked, n.stars.count, n.attempts, n.bestUnassistedMs]),
    ).toEqual([
      ['b', true, 0, 0, undefined],
      ['a', false, 3, 2, 30_000],
    ]);
  });

  function scenario0(): Scenario {
    return {
      id: 's',
      title: 'S',
      levelRange: { min: 'N1', max: 'L2' },
      npc: { id: 'n', name: '店員', personality: 'p', speechStyle: 's', particles: [] },
      setting: 's',
      goalSteps: [{ id: 'g', description: 'd', keywordHints: ['咖啡', '錢'] }],
      vocabExtras: ['咖啡', '便利商店', '機車'],
      opener: { zh: '你好，要喝咖啡嗎？', en: 'Hi' },
      successLine: { zh: '謝謝，一共三塊錢！', en: 'Thanks' },
    };
  }

  it('scenario coverage equals analyzeText over the scenario corpus', () => {
    const s = scenario0();
    const known = new Set(
      ['你好', '咖啡', '喝', '嗎', '錢'].flatMap((hw) => lexicon.lookup(hw).map((w) => w.id)),
    );
    const ctx = coverageContext(lexicon, 'L1', known);
    const corpus = scenarioCorpus(s, ['我要買機車。']);
    const result = scenarioCoverage(corpus, ctx);
    const direct = analyzeText(corpus.join('\n'), ctx);
    expect(result.coverage).toBe(direct.coverage);
    expect(result.tokens).toBe(direct.classifications.length);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.coverage).toBeLessThan(1);
    expect(result.missing).toContain('機車');
    expect(result.missing).not.toContain('咖啡');
    // knowing more raises coverage
    const more = new Set([
      ...known,
      ...lexicon.lookup('機車').map((w) => w.id),
      ...lexicon.lookup('便利商店').map((w) => w.id),
    ]);
    expect(scenarioCoverage(corpus, coverageContext(lexicon, 'L1', more)).coverage).toBeGreaterThan(
      result.coverage,
    );
    expect(scenarioCoverage([], ctx).coverage).toBe(1);
  });
});

describe('streaks', () => {
  const keys = (...days: number[]) => days.map((d) => dayKey(day(d)));

  it('counts consecutive days and keeps the best', () => {
    expect(computeStreak(keys(1, 2, 3), day(3))).toMatchObject({ current: 3, best: 3 });
    expect(computeStreak([], day(3))).toEqual({ current: 0, best: 0, freezesUsed: 0 });
  });

  it('an empty today never breaks the run', () => {
    expect(computeStreak(keys(1, 2, 3), day(4)).current).toBe(3);
  });

  it('freeze days bridge gaps (up to the weekly allowance), then a long gap just starts over', () => {
    expect(computeStreak(keys(1, 4), day(4))).toMatchObject({ current: 2, freezesUsed: 2 }); // 2 skipped, within 2 freezes
    const broken = computeStreak(keys(1, 2, 3, 8), day(8));
    expect(broken).toMatchObject({ current: 1, best: 3 }); // 4 skipped days: run restarts, best kept
    expect(computeStreak(keys(1, 4), day(4), { enabled: true, freezeDaysPerWeek: 0 }).current).toBe(
      1,
    );
  });

  it('is off by default', async () => {
    const { DEFAULT_STREAK_CONFIG } = await import('./streak.js');
    expect(DEFAULT_STREAK_CONFIG.enabled).toBe(false);
  });

  it('summarises the last 7 days only', () => {
    const e = (kind: string, points: number, d: number) => ({ kind, points, at: day(d) });
    const s = weeklySummary(
      [
        e('recall_correct', 2, 10),
        e('recall_hinted', 1, 9),
        e('journal_entry', 8, 9),
        e('scenario_completed', 10, 4),
        e('error_fixed', 3, 10),
        e('self_correction', 4, 3),
        e('recall_correct', 2, 2),
      ],
      day(10),
    );
    expect(s).toMatchObject({
      points: 24,
      activeDays: 3,
      wordsRecalled: 2,
      journalEntries: 1,
      scenariosCompleted: 1,
      mistakesFixed: 1,
    });
  });
});

describe('metrics', () => {
  const ev = (id: string, kind: Evidence['kind'], d: number): Evidence => ({
    item: { kind: 'word', id },
    skill: 'recognition',
    kind,
    at: day(d),
  });

  it("retention excludes each item's first graded answer and counts only graded recall", () => {
    const stats = actualRetention(
      [
        ev('a', 'review_good', 1), // first -> learning step, excluded
        ev('a', 'review_good', 5),
        ev('a', 'review_again', 9),
        ev('b', 'cloze_wrong', 1), // first, excluded
        ev('b', 'cloze_correct_nohint', 4),
        ev('b', 'chat_read_no_lookup', 6), // not graded
      ],
      0.9,
    );
    expect(stats).toEqual({ actual: 2 / 3, reviews: 3, target: 0.9 });
    expect(actualRetention([], 0.9).actual).toBeNull();
  });

  it('scenario help metrics', () => {
    const c = (over: Partial<ConversationRecord & { learnerTurns: number }>) => ({
      scenarioId: 'a',
      startedAt: day(1, 10),
      endedAt: new Date(day(1, 10).getTime() + 120_000),
      completed: true,
      stuckCount: 0,
      englishFallbackUsed: false,
      learnerTurns: 10,
      ...over,
    });
    const m = scenarioMetrics([
      c({}),
      c({ stuckCount: 2 }),
      c({ completed: false, endedAt: undefined }),
    ]);
    expect(m).toMatchObject({
      attempts: 3,
      completed: 2,
      completedUnassisted: 1,
      unassistedRate: 0.5,
      meanUnassistedMs: 120_000,
    });
    expect(m.turnsWithoutStuck).toBeCloseTo(1 - 2 / 30);
    expect(scenarioMetrics([]).unassistedRate).toBeNull();
  });
});
