import { useMemo, useState } from 'react';
import {
  applyPlacementRound,
  DEFAULT_PLACEMENT_CONFIG,
  initPlacementState,
  LEVEL_ORDER,
  nextPlacementRound,
  summarizePlacement,
  type Evidence,
  type Level,
  type Lexicon,
  type PlacementRound,
  type PlacementState,
} from '@anan/core';
import { learnerService } from '../db/instance.js';
import { useLexicon } from '../lib/useLexicon.js';
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
  const bulkKnownEvents: Evidence[] = lexicon
    .allWords()
    .filter((w) => w.level !== null && LEVEL_ORDER.indexOf(w.level) < boundaryIdx && !judgedIds.has(w.id))
    .map((w) => ({ item: { kind: 'word', id: w.id }, skill: 'recognition', kind: 'placement_known', at: now }));

  await learnerService.recordBulk([...overrideEvents, ...bulkKnownEvents], now);
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
    const boundaryIdx = LEVEL_ORDER.indexOf(level) + 1; // "start at level X": X and below treated known
    const events: Evidence[] = lexicon
      .allWords()
      .filter((w) => w.level !== null && LEVEL_ORDER.indexOf(w.level) < boundaryIdx)
      .map((w) => ({ item: { kind: 'word', id: w.id }, skill: 'recognition', kind: 'placement_known', at: now }));
    await learnerService.recordBulk(events, now);
    const state: PlacementState = { ...initPlacementState(), lo: boundaryIdx, hi: boundaryIdx, phase: 'done' };
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
    const nextState = applyPlacementRound(stage.state, stage.round, answers, DEFAULT_PLACEMENT_CONFIG);
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

  const totalTaps = stage.kind === 'running' ? stage.state.judgements.length + stage.answers.length : 0;

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
                  {level}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {stage.kind === 'running' && (
        <div className="placement-round">
          <p className="placement-progress">
            Tap {totalTaps + 1} · level {stage.round.level}
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
        <PlacementSummary state={stage.state} bulkCount={applySummary?.bulkCount ?? 0} />
      )}
    </div>
  );
}

function PlacementSummary({ state, bulkCount }: { state: PlacementState; bulkCount: number }) {
  const result = summarizePlacement(state);
  return (
    <div className="placement-summary">
      <p>
        Placed at <strong>{result.boundaryLevel ?? 'beyond L6'}</strong>
        {result.boundaryLevel && ` (levels before ${result.boundaryLevel} marked known)`}.
      </p>
      <p className="placement-bulk-note">{bulkCount} words marked known for light first review.</p>
      <h2>Level-by-level summary</h2>
      <ul className="placement-level-summary">
        {LEVEL_ORDER.map((level) => {
          const tally = result.byLevel[level];
          if (!tally) return null;
          return (
            <li key={level}>
              {level}: {tally.known}/{tally.total} known
            </li>
          );
        })}
      </ul>
    </div>
  );
}
