import { useEffect, useState } from 'react';
import {
  groupPlots,
  isTextbookTagged,
  wiltingCards,
  type GrowthStage,
  type Level,
  type Lexicon,
  type Plant,
  type Plot,
  type SkillCard,
  type StoryRecord,
  type Wilt,
  type Word,
} from '@anan/core';
import { AnnotatedWord, useReadingScript } from '../components/AnnotatedInline.js';
import type { AnnotationScript } from '../components/AnnotatedText.js';
import { LevelChips } from '../components/LevelPicker.js';
import { db } from '../db/instance.js';
import { onStudyDirty } from '../lib/study-dirty.js';
import { allWateredLine, NOTHING_DUE, nextSessionTip, TERM } from '../lib/labels.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { loadGameSnapshot, type GameSnapshot } from '../lib/game-data.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import { useStudyFocus } from '../lib/study.js';
import { NowStudying } from '../components/NowStudying.js';
import { DueForecast, HomeReviewActions } from '../components/DueForecast.js';
import { EmptySprout, NextDropIcon, PlantLegend, StageIcon } from '../components/PlantIcons.js';
import { useLedger } from '../lib/ledger.js';
import { StreakBar } from '../components/StreakBar.js';
import { WaterAllPage } from './WaterAllPage.js';
import { HomeStoryLine } from './StoriesSection.js';
import { StoryView } from './StoryView.js';
import { useOptionalStoryService } from '../lib/stories.js';
import { ReviewPage } from './ReviewPage.js';
import './GardenPage.css';

/** Phase 21: the plant art keeps its metaphor; the words are the shared terms. */
const STAGE_LABEL: Record<GrowthStage, string> = {
  seed: TERM.new,
  sprout: 'learning',
  plant: TERM.learned,
  bloom: TERM.mastered,
};
const WILT_LABEL: Record<Wilt, string> = {
  healthy: 'not due in this session',
  wilting: `${TERM.due} — needs water`,
  withered: `${TERM.due}, fading fast — needs water`,
};

/** Phase 6 §2: the word garden / map. Growth = learning state; wilt = FSRS
 * retrievability below your target. Wilt is also spelled out in text and in
 * the tile's label, so it never depends on colour alone. */
export function GardenPage() {
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();
  const script = useReadingScript();
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const { level } = useCurrentLevel();
  // Phase 7 per-screen filter: defaults to My level, changes here never touch it.
  const [levelFilter, setLevelFilter] = useState<Level[]>([level]);
  useEffect(() => setLevelFilter([level]), [level]);
  // Phase 12: only words from the class textbook (offered once any exist in the garden).
  const [textbookOnly, setTextbookOnly] = useState(false);
  const [focus, setFocus] = useState<SkillCard[] | null>(null);
  // Phase 22: Home's "Water all", "Review all" and "Review early" (Phase 23: the next session now).
  const [session, setSession] = useState<'water-all' | 'review-all' | 'review-early' | { story: StoryRecord } | null>(null);
  const ledger = useLedger();
  const stories = useOptionalStoryService(lexiconState.status === 'ready' ? lexiconState.lexicon : null);
  // Phase 14: tiles that belong to the active study step are highlighted.
  const { focus: studyFocus } = useStudyFocus();
  const activeIds = new Set(
    studyFocus?.enabled ? studyFocus.focusItems.filter((i) => i.kind === 'word').map((i) => i.id) : [],
  );
  const [refresh, setRefresh] = useState(0);
  // Phase 21: every change (a review here, "Study this lesson", a sync merge) refreshes the garden.
  useEffect(() => onStudyDirty(() => setRefresh((k) => k + 1)), []);
  // Phase 27: when a session opens or ends (the status re-reads itself then), the plants follow.
  const sessionMark = ledger ? `${ledger.status.session}|${ledger.status.nextSession.opensAt.getTime()}` : '';
  useEffect(() => {
    if (sessionMark) setRefresh((k) => k + 1);
  }, [sessionMark]);

  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const snap = await loadGameSnapshot(db, lexiconState.lexicon, scenariosState.scenarios, new Date(), undefined, level);
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

  const backHome = () => {
    setSession(null);
    setFocus(null);
    setRefresh((k) => k + 1);
    window.scrollTo(0, 0);
  };
  if (session === 'water-all') return <WaterAllPage onExit={backHome} />;
  if (session === 'review-all')
    return <ReviewPage reviewAll title="Review all" exitLabel="← Back to home" onExit={backHome} />;
  if (session && typeof session === 'object' && 'story' in session && lexiconState.status === 'ready')
    return (
      <StoryView
        story={session.story}
        service={stories!}
        lexicon={lexiconState.lexicon}
        level={level}
        exitLabel="← Back to home"
        onExit={backHome}
      />
    );
  // Phase 29 Part B.5: one Review early (the Review page's own, capped like any session).
  if (session === 'review-early')
    return <ReviewPage reviewEarly title="Review early" exitLabel="← Back to home" onExit={backHome} />;
  if (focus) {
    return <ReviewPage focusCards={focus} keepEvery onExit={backHome} />;
  }

  const lexicon = lexiconState.status === 'ready' ? lexiconState.lexicon : null;
  const inFilter = (p: Plant) => {
    if (!lexicon) return true;
    const word = lexicon.byId(p.wordId);
    // "Textbook only" replaces the level filter: the book's words span levels.
    if (textbookOnly) return word ? isTextbookTagged(word.tags) : false;
    if (levelFilter.length === 0) return true;
    return word?.level ? levelFilter.includes(word.level) : false;
  };
  const hasTextbookWords =
    !!lexicon && snapshot.plants.some((p) => isTextbookTagged(lexicon.byId(p.wordId)?.tags ?? []));
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
      <NowStudying />
      <HomeReviewActions
        ledger={ledger}
        onWaterAll={() => setSession('water-all')}
        onReviewAll={() => setSession('review-all')}
        onReviewEarly={() => setSession('review-early')}
      />
      <StreakBar ledger={ledger} />
      {stories && <HomeStoryLine service={stories} level={level} onOpen={(story) => setSession({ story })} />}
      <DueForecast ledger={ledger} />
      {snapshot.plants.length === 0 && <EmptySprout />}
      <p className="garden-meta">
        {shownPlants.length === 0
          ? snapshot.plants.length === 0
            ? 'No words yet. Meet some words in Chat or Review and they will appear here.'
            : 'No words at the selected levels yet.'
          : `${shownPlants.length} words${wilting === 0 ? '' : ` · ${wilting} need water (${TERM.due.toLowerCase()})`}`}
      </p>
      {snapshot.plants.length > 0 && snapshot.status.thirstyWords === 0 && (
        <p className="garden-meta garden-watered" data-testid="garden-watered">
          {allWateredLine(snapshot.status.nextSession, snapshot.status.nextSessionWordIds.length, snapshot.status.timeZone)}
        </p>
      )}
      <PlantLegend extra={<span>⚠ tricky word (never {TERM.mastered})</span>} />
      <LevelChips selected={levelFilter} onChange={setLevelFilter} current={level} />
      {(hasTextbookWords || textbookOnly) && (
        <label className="garden-textbook-filter">
          <input
            type="checkbox"
            checked={textbookOnly}
            onChange={(e) => setTextbookOnly(e.target.checked)}
          />{' '}
          Textbook only <span lang="zh-Hant">(來學華語)</span>
        </label>
      )}
      {hiddenWilting > 0 && (
        <p className="garden-meta">
          {hiddenWilting} {hiddenWilting === 1 ? 'word needs' : 'words need'} water at other levels — pick
          “All” to see them. Your due reviews are never hidden.
        </p>
      )}
      <div className="garden-plots">
        {plots.map((plot) => (
          <PlotView
            key={plot.id}
            plot={plot}
            lexicon={lexicon}
            script={script}
            // Phase 29 Part B.5: a plot's water button is one session too (capped like any session).
            onWater={() => setFocus(wiltingCards(plot).slice(0, Math.max(1, ledger?.status.capLeft ?? Infinity)))}
            activeIds={activeIds}
          />
        ))}
      </div>
    </div>
  );
}

function PlotView({
  plot,
  lexicon,
  script,
  onWater,
  activeIds,
}: {
  activeIds: ReadonlySet<string>;
  plot: Plot;
  lexicon: Lexicon | null;
  script: AnnotationScript;
  onWater: () => void;
}) {
  return (
    <section
      className={`garden-plot garden-plot--${plot.wiltingCount > 0 ? 'thirsty' : 'ok'}${plot.plants.some((p) => activeIds.has(p.wordId) && p.stage !== 'bloom') ? ' garden-plot--active' : ''}`}
      data-testid={plot.plants.some((p) => activeIds.has(p.wordId) && p.stage !== 'bloom') ? 'plot-active' : undefined}
    >
      <header>
        <h2 lang={plot.kind === 'level' ? 'zh-Hant' : undefined}>{plot.title}</h2>
        <span className="garden-plot-count">{plot.kind === 'scenario' ? 'scenario' : 'level'}</span>
      </header>
      <div className="garden-tiles">
        {plot.plants.map((p) => (
          <Tile
            key={p.wordId}
            plant={p}
            word={lexicon?.byId(p.wordId)}
            script={script}
            active={activeIds.has(p.wordId) && p.stage !== 'bloom'}
          />
        ))}
      </div>
      {plot.wiltingCount > 0 ? (
        <button className="garden-water btn-water" onClick={onWater}>
          💧 Water {plot.wiltingCount} {plot.wiltingCount === 1 ? 'word' : 'words'}
        </button>
      ) : (
        <p className="garden-ok">{NOTHING_DUE}</p>
      )}
    </section>
  );
}

function Tile({
  plant,
  word,
  script,
  active,
}: {
  active?: boolean;
  plant: Plant;
  word: Word | undefined;
  script: AnnotationScript;
}) {
  const pct = plant.retrievability === null ? null : Math.round(plant.retrievability * 100);
  return (
    <div
      className={`garden-tile garden-tile--${plant.wilt}${active ? ' garden-tile--active' : ''}`}
      role="group"
      aria-label={`${plant.headword}: ${STAGE_LABEL[plant.stage]}${plant.leech ? `, ${TERM.leech.toLowerCase()}` : ''}, ${WILT_LABEL[plant.wilt]}${plant.wilt === 'healthy' && plant.nextSession ? ` (${nextSessionTip(plant.nextSession).toLowerCase()})` : ''}${pct === null ? '' : `, ${pct}% remembered`}`}
      title={`${plant.headword} — ${STAGE_LABEL[plant.stage]}${plant.leech ? ` (${TERM.leech.toLowerCase()})` : ''}, ${WILT_LABEL[plant.wilt]}${pct === null ? '' : ` (${pct}%)`}`}
      data-stage={plant.stage}
    >
      <span className="garden-plant" aria-hidden="true">
        <StageIcon stage={plant.stage} />
      </span>
      <span className="garden-word" lang="zh-Hant">
        {word ? <AnnotatedWord word={word} script={script} /> : plant.headword}
      </span>
      {plant.leech && (
        <span className="garden-leech-mark" title={TERM.leech} data-testid="leech-mark">
          ⚠
        </span>
      )}
      {plant.wilt !== 'healthy' && (
        <span className="garden-wilt-mark">{plant.wilt === 'withered' ? '!!' : '!'}</span>
      )}
      {plant.wilt === 'healthy' && plant.nextSession && (
        <span className="garden-next-mark" title={nextSessionTip(plant.nextSession)} data-testid="next-session-mark">
          <NextDropIcon label={nextSessionTip(plant.nextSession)} />
        </span>
      )}
    </div>
  );
}
