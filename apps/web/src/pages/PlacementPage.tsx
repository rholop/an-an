import { useMemo, useState } from 'react';
import {
  applyPlacementRound,
  DEFAULT_PLACEMENT_CONFIG,
  initPlacementState,
  LEVEL_ORDER,
  levelItems,
  nextPlacementRound,
  summarizePlacement,
  type Evidence,
  type Level,
  type Lexicon,
  type PlacementRound,
  type PlacementState,
} from '@anan/core';
import { learnerService } from '../db/instance.js';
import { setCurrentLevel } from '../lib/current-level.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useProgressData } from '../lib/study.js';
import { LearnedMastered } from '../components/LearnedMastered.js';
import { levelShort, placedAtLine } from '../lib/labels.js';
import './PlacementPage.css';

type Stage =
  | { kind: 'manual-or-start' }
  | { kind: 'running'; state: PlacementState; round: PlacementRound; answers: boolean[] }
  | { kind: 'applying' }
  | { kind: 'done'; state: PlacementState };

async function applyPlacementResult(state: PlacementState, lexicon: Lexicon, now: Date) {
  const result = summarizePlacement(state);
  const boundaryIdx = result.boundaryLevelIndex;

  // Per-word overrides from individual taps take priority...
  const judgedIds = new Set(result.judgements.map((j) => j.wordId));
  const overrideEvents: Evidence[] = result.judgements.map((j) => ({
    item: { kind: 'word', id: j.wordId },
    skill: 'recognition',
    kind: j.known ? 'placement_known' : 'placement_unknown',
    at: now,
  }));

  // ...then every OTHER word at a level strictly below the boundary is
  // bulk-marked known (flagged probablyKnown — first real review is a light
  // verification per phase doc §5), since testing every single word isn't
  // feasible. Words at/above the boundary that weren't individually tapped
  // are left untouched (genuinely unseen, no row written).
  // Phase 21: the one level item set (TOCFL-list words of each level).
  const bulkKnownEvents: Evidence[] = LEVEL_ORDER.slice(0, boundaryIdx)
    .flatMap((lv) => levelItems(lv, lexicon.allWords()))
    .filter((i) => !judgedIds.has(i.id))
    .map((item) => ({ item, skill: 'recognition', kind: 'placement_known', at: now }));

  await learnerService.recordBulk([...overrideEvents, ...bulkKnownEvents], now);
  // Phase 7: placement sets "My level" to the first level not yet known (still
  // overridable from the header picker).
  await setCurrentLevel(LEVEL_ORDER[Math.min(boundaryIdx, LEVEL_ORDER.length - 1)]!);
  return { result, bulkCount: bulkKnownEvents.length };
}

export function PlacementPage() {
  const lexiconState = useLexicon();
  const [stage, setStage] = useState<Stage>({ kind: 'manual-or-start' });
  const [applySummary, setApplySummary] = useState<{ bulkCount: number } | null>(null);
  const rng = useMemo(() => Math.random, []);

  if (lexiconState.status === 'loading') return <p>Loading…</p>;
  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  const lexicon = lexiconState.lexicon;

  function startAdaptive() {
    const state = initPlacementState();
    const round = nextPlacementRound(state, lexicon, DEFAULT_PLACEMENT_CONFIG, rng);
    if (!round) {
      setStage({ kind: 'done', state });
      return;
    }
    setStage({ kind: 'running', state, round, answers: [] });
  }

  async function startManual(level: Level) {
    setStage({ kind: 'applying' });
    const now = new Date();
    // Phase 21: "Placed at X": X is the level to learn; the levels below it are marked known.
    const boundaryIdx = LEVEL_ORDER.indexOf(level);
    const events: Evidence[] = LEVEL_ORDER.slice(0, boundaryIdx)
      .flatMap((lv) => levelItems(lv, lexicon.allWords()))
      .map((item) => ({ item, skill: 'recognition', kind: 'placement_known', at: now }));
    await learnerService.recordBulk(events, now);
    await setCurrentLevel(LEVEL_ORDER[Math.min(boundaryIdx, LEVEL_ORDER.length - 1)]!);
    const state: PlacementState = {
      ...initPlacementState(),
      lo: boundaryIdx,
      hi: boundaryIdx,
      phase: 'done',
    };
    setApplySummary({ bulkCount: events.length });
    setStage({ kind: 'done', state });
  }

  function answer(known: boolean) {
    if (stage.kind !== 'running') return;
    const answers = [...stage.answers, known];
    if (answers.length < stage.round.words.length) {
      setStage({ ...stage, answers });
      return;
    }
    // round complete
    const nextState = applyPlacementRound(
      stage.state,
      stage.round,
      answers,
      DEFAULT_PLACEMENT_CONFIG,
    );
    const nextRound = nextPlacementRound(nextState, lexicon, DEFAULT_PLACEMENT_CONFIG, rng);
    if (nextState.phase === 'done' || !nextRound) {
      setStage({ kind: 'applying' });
      applyPlacementResult(nextState, lexicon, new Date()).then(({ bulkCount }) => {
        setApplySummary({ bulkCount });
        setStage({ kind: 'done', state: nextState });
      });
      return;
    }
    setStage({ kind: 'running', state: nextState, round: nextRound, answers: [] });
  }

  const totalTaps =
    stage.kind === 'running' ? stage.state.judgements.length + stage.answers.length : 0;

  return (
    <div className="placement-page">
      <h1>Placement test</h1>

      {stage.kind === 'manual-or-start' && (
        <div className="placement-start">
          <button className="placement-start-btn" onClick={startAdaptive}>
            Start adaptive test (~40 taps)
          </button>
          <div className="placement-manual">
            <p>Or start manually at a level:</p>
            <div className="placement-manual-levels">
              {LEVEL_ORDER.map((level) => (
                <button key={level} onClick={() => startManual(level)}>
                  {levelShort(level)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {stage.kind === 'running' && (
        <div className="placement-round">
          <p className="placement-progress">
            Tap {totalTaps + 1} · level {levelShort(stage.round.level)}
          </p>
          <div className="placement-word">{stage.round.words[stage.answers.length]?.headword}</div>
          <div className="placement-buttons">
            <button className="placement-btn placement-btn--no" onClick={() => answer(false)}>
              Don't know
            </button>
            <button className="placement-btn placement-btn--yes" onClick={() => answer(true)}>
              I know this
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'applying' && <p>Saving results…</p>}

      {stage.kind === 'done' && (
        <PlacementSummary state={stage.state} bulkCount={applySummary?.bulkCount ?? 0} lexicon={lexicon} />
      )}
    </div>
  );
}

function PlacementSummary({ state, bulkCount, lexicon }: { state: PlacementState; bulkCount: number; lexicon: Lexicon }) {
  const result = summarizePlacement(state);
  const progress = useProgressData();
  const below = result.boundaryLevel ? LEVEL_ORDER.slice(0, LEVEL_ORDER.indexOf(result.boundaryLevel)) : [...LEVEL_ORDER];
  return (
    <div className="placement-summary">
      <p data-testid="placed-at">
        {result.boundaryLevel ? placedAtLine(result.boundaryLevel) : 'Placed beyond L5'}.
        {below.length > 0 && ` ${below.map(levelShort).join(', ')} marked as known.`}
      </p>
      <p className="placement-bulk-note">
        {bulkCount} words marked known. They show as Imported until you first get them right in review
        (words you already had are left as they were).
      </p>
      <h2>Level-by-level summary</h2>
      <ul className="placement-level-summary">
        {LEVEL_ORDER.map((level) => {
          const tally = result.byLevel[level];
          return (
            <li key={level}>
              {levelShort(level)}
              {tally ? `: ${tally.known}/${tally.total} known in the test` : ''}
              {progress && (
                <LearnedMastered
                  compact
                  testId={`placement-progress-${level}`}
                  p={progress.index.summarize(levelItems(level, lexicon.allWords()))}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
