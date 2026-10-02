import { useEffect, useState } from 'react';
import {
  groupPlots,
  wiltingCards,
  type GrowthStage,
  type Level,
  type Plant,
  type Plot,
  type SkillCard,
  type Wilt,
} from '@anan/core';
import { LevelChips } from '../components/LevelPicker.js';
import { db, gameService } from '../db/instance.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { loadGameSnapshot, type GameSnapshot } from '../lib/game-data.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import { ReviewPage } from './ReviewPage.js';
import './GardenPage.css';

const STAGE_ICON: Record<GrowthStage, string> = {
  seed: '🌰',
  sprout: '🌱',
  plant: '🌿',
  bloom: '🌸',
};
const STAGE_LABEL: Record<GrowthStage, string> = {
  seed: 'just met',
  sprout: 'learning',
  plant: 'growing',
  bloom: 'well known',
};
const WILT_LABEL: Record<Wilt, string> = {
  healthy: 'healthy',
  wilting: 'wilting — needs water',
  withered: 'withered — needs water soon',
};

/** Phase 6 §2: the word garden / map. Growth = learning state; wilt = FSRS
 * retrievability below your target. Wilt is also spelled out in text and in
 * the tile's label, so it never depends on colour alone. */
export function GardenPage() {
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const { level } = useCurrentLevel();
  // Phase 7 per-screen filter: defaults to My level, changes here never touch it.
  const [levelFilter, setLevelFilter] = useState<Level[]>([level]);
  useEffect(() => setLevelFilter([level]), [level]);
  const [focus, setFocus] = useState<SkillCard[] | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const target = await gameService.getTargetRetention();
      const snap = await loadGameSnapshot(
        db,
        lexiconState.lexicon,
        scenariosState.scenarios,
        new Date(),
        target,
        level,
      );
      if (!cancelled) setSnapshot(snap);
    })();
    return () => {
      cancelled = true;
    };
  }, [lexiconState, scenariosState, refresh, level]);

  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (scenariosState.status === 'error')
    return <p>Failed to load scenarios: {scenariosState.error}</p>;
  if (!snapshot) return <p>Loading…</p>;

  if (focus) {
    return (
      <ReviewPage
        focusCards={focus}
        onExit={() => {
          setFocus(null);
          setRefresh((k) => k + 1);
        }}
      />
    );
  }

  const lexicon = lexiconState.status === 'ready' ? lexiconState.lexicon : null;
  const inFilter = (p: Plant) => {
    if (levelFilter.length === 0 || !lexicon) return true;
    const lvl = lexicon.byId(p.wordId)?.level;
    return lvl ? levelFilter.includes(lvl) : false;
  };
  const shownPlants = snapshot.plants.filter(inFilter);
  const plots =
    lexicon && scenariosState.status === 'ready'
      ? groupPlots(shownPlants, scenariosState.scenarios, lexicon)
      : snapshot.plots;
  const wilting = shownPlants.filter((p) => p.wilt !== 'healthy').length;
  const hiddenWilting = snapshot.plants.filter((p) => !inFilter(p) && p.wilt !== 'healthy').length;

  return (
    <div className="garden-page">
      <h1>Word garden</h1>
      <p className="garden-meta">
        {shownPlants.length === 0
          ? snapshot.plants.length === 0
            ? 'Nothing planted yet — meet some words in Chat or Review and they will appear here.'
            : 'No words at the selected levels yet.'
          : `${shownPlants.length} words planted · ${wilting === 0 ? 'all healthy' : `${wilting} need water`}`}
      </p>
      <p className="garden-legend">
        {(Object.keys(STAGE_ICON) as GrowthStage[]).map((s) => (
          <span key={s}>
            {STAGE_ICON[s]} {STAGE_LABEL[s]}{' '}
          </span>
        ))}
        · faded and drooping = memory fading below your target
      </p>
      <LevelChips selected={levelFilter} onChange={setLevelFilter} current={level} />
      {hiddenWilting > 0 && (
        <p className="garden-meta">
          {hiddenWilting} wilting {hiddenWilting === 1 ? 'word' : 'words'} at other levels — pick
          “All” to see them. Your due reviews are never hidden.
        </p>
      )}
      <div className="garden-plots">
        {plots.map((plot) => (
          <PlotView key={plot.id} plot={plot} onWater={() => setFocus(wiltingCards(plot))} />
        ))}
      </div>
    </div>
  );
}

function PlotView({ plot, onWater }: { plot: Plot; onWater: () => void }) {
  return (
    <section className={`garden-plot garden-plot--${plot.wiltingCount > 0 ? 'thirsty' : 'ok'}`}>
      <header>
        <h2>{plot.title}</h2>
        <span className="garden-plot-count">{plot.kind === 'scenario' ? 'scenario' : 'level'}</span>
      </header>
      <div className="garden-tiles">
        {plot.plants.map((p) => (
          <Tile key={p.wordId} plant={p} />
        ))}
      </div>
      {plot.wiltingCount > 0 ? (
        <button className="garden-water" onClick={onWater}>
          💧 Water {plot.wiltingCount} wilting {plot.wiltingCount === 1 ? 'word' : 'words'}
        </button>
      ) : (
        <p className="garden-ok">All healthy</p>
      )}
    </section>
  );
}

function Tile({ plant }: { plant: Plant }) {
  const pct = plant.retrievability === null ? null : Math.round(plant.retrievability * 100);
  return (
    <div
      className={`garden-tile garden-tile--${plant.wilt}`}
      role="img"
      aria-label={`${plant.headword}: ${STAGE_LABEL[plant.stage]}, ${WILT_LABEL[plant.wilt]}${pct === null ? '' : `, ${pct}% remembered`}`}
      title={`${plant.headword} — ${STAGE_LABEL[plant.stage]}, ${WILT_LABEL[plant.wilt]}${pct === null ? '' : ` (${pct}%)`}`}
    >
      <span className="garden-plant" aria-hidden="true">
        {STAGE_ICON[plant.stage]}
      </span>
      <span className="garden-word" lang="zh-Hant">
        {plant.headword}
      </span>
      {plant.wilt !== 'healthy' && (
        <span className="garden-wilt-mark">{plant.wilt === 'withered' ? '!!' : '!'}</span>
      )}
    </div>
  );
}
