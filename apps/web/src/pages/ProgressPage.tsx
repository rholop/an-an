import { useEffect, useState } from 'react';
import {
  actualRetention,
  computeStreak,
  dayKey,
  formatDuration,
  REWARD_TABLE,
  scenarioMetrics,
  totalPoints,
  weeklySummary,
  type RewardKind,
  type StreakConfig,
} from '@anan/core';
import { JournalProgress } from '../components/JournalProgress.js';
import { db, gameService } from '../db/instance.js';
import { useCurrentLevel } from '../lib/current-level.js';
import { loadGameSnapshot, type GameSnapshot } from '../lib/game-data.js';
import { useLexicon } from '../lib/useLexicon.js';
import { useScenarios } from '../lib/useScenarios.js';
import './ProgressPage.css';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Phase 6 §1, §4, §5, §6: points, real-world coverage, the (optional) streak
 * and weekly summary, and the evaluation metrics from the project overview. */
export function ProgressPage() {
  const { level } = useCurrentLevel();
  const lexiconState = useLexicon();
  const scenariosState = useScenarios();
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [retention, setRetention] = useState<ReturnType<typeof actualRetention> | null>(null);
  const [streakConfig, setStreakConfig] = useState<StreakConfig | null>(null);
  const now = new Date();

  useEffect(() => {
    if (lexiconState.status !== 'ready' || scenariosState.status !== 'ready') return;
    let cancelled = false;
    (async () => {
      const target = await gameService.getTargetRetention();
      const [snap, evidence, streak] = await Promise.all([
        loadGameSnapshot(
          db,
          lexiconState.lexicon,
          scenariosState.scenarios,
          new Date(),
          target,
          level,
        ),
        db.evidence.toArray(),
        gameService.getStreakConfig(),
      ]);
      if (cancelled) return;
      setSnapshot(snap);
      setRetention(actualRetention(evidence, target));
      setStreakConfig(streak);
    })();
    return () => {
      cancelled = true;
    };
  }, [lexiconState, scenariosState, level]);

  if (lexiconState.status === 'error') return <p>Failed to load lexicon: {lexiconState.error}</p>;
  if (scenariosState.status === 'error')
    return <p>Failed to load scenarios: {scenariosState.error}</p>;
  if (!snapshot || !retention || !streakConfig || scenariosState.status !== 'ready')
    return <p>Loading…</p>;

  const byKind = new Map<string, { count: number; points: number }>();
  for (const r of snapshot.rewards) {
    const cur = byKind.get(r.kind) ?? { count: 0, points: 0 };
    byKind.set(r.kind, { count: cur.count + 1, points: cur.points + r.points });
  }
  const week = weeklySummary(snapshot.rewards, now);
  const streak = computeStreak(
    new Set(snapshot.rewards.map((r) => dayKey(r.at))),
    now,
    streakConfig,
  );
  const sm = scenarioMetrics(snapshot.conversations);

  async function updateStreak(next: StreakConfig) {
    setStreakConfig(next);
    await gameService.setStreakConfig(next);
  }

  return (
    <div className="progress-page">
      <h1>Progress</h1>

      <section>
        <h2>Points: {totalPoints(snapshot.rewards)}</h2>
        <p className="progress-muted">
          Points come only from learning: recalling words, finishing scenarios, journaling and
          fixing mistakes — never from time spent or opening the app.
        </p>
        {byKind.size > 0 && (
          <table className="progress-table">
            <tbody>
              {[...byKind.entries()].map(([kind, v]) => (
                <tr key={kind}>
                  <td data-label="Activity">{REWARD_TABLE[kind as RewardKind]?.label ?? kind}</td>
                  <td data-label="Times">×{v.count}</td>
                  <td data-label="Points">{v.points} pts</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>This week</h2>
        <ul>
          <li>{week.wordsRecalled} words recalled</li>
          <li>{week.scenariosCompleted} scenarios completed</li>
          <li>{week.journalEntries} journal entries</li>
          <li>{week.mistakesFixed} mistakes fixed</li>
          <li>
            {week.points} points over {week.activeDays} {week.activeDays === 1 ? 'day' : 'days'}
          </li>
        </ul>
        {streakConfig.enabled && (
          <p data-testid="streak">
            Current run: {streak.current} {streak.current === 1 ? 'day' : 'days'} · best{' '}
            {streak.best}. Rest days are fine — up to {streakConfig.freezeDaysPerWeek} a week
            don&apos;t break it.
          </p>
        )}
        <details>
          <summary>Streak settings</summary>
          <label>
            <input
              type="checkbox"
              checked={streakConfig.enabled}
              onChange={(e) => updateStreak({ ...streakConfig, enabled: e.target.checked })}
            />{' '}
            Show a gentle streak (off by default)
          </label>
          {streakConfig.enabled && (
            <label>
              {' '}
              Rest days per week:{' '}
              <select
                value={streakConfig.freezeDaysPerWeek}
                onChange={(e) =>
                  updateStreak({ ...streakConfig, freezeDaysPerWeek: Number(e.target.value) })
                }
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
        </details>
      </section>

      <section>
        <h2>In the real world</h2>
        <p className="progress-muted">
          How much of the everyday language in each situation you can already follow.
        </p>
        <ul className="progress-coverage">
          {scenariosState.scenarios.map((s) => {
            const c = snapshot.coverage.get(s.id)!;
            return (
              <li key={s.id}>
                <div>
                  <strong>{s.title}</strong>: you can handle ~{pct(c.coverage)} of the words
                </div>
                <progress value={c.coverage} max={1} aria-label={`${s.title} coverage`} />
                {c.missing.length > 0 && (
                  <div className="progress-muted">
                    Still to learn: <span lang="zh-Hant">{c.missing.slice(0, 8).join('、')}</span>
                    {c.missing.length > 8 && ` and ${c.missing.length - 8} more`}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2>Is it working?</h2>
        <ul>
          <li data-testid="retention">
            Review retention:{' '}
            {retention.actual === null
              ? 'not enough reviews yet'
              : `${pct(retention.actual)} actual vs ${pct(retention.target)} target (${retention.reviews} reviews)`}
          </li>
          <li>
            Scenarios completed without help:{' '}
            {sm.unassistedRate === null
              ? 'none completed yet'
              : `${pct(sm.unassistedRate)} (${sm.completedUnassisted} of ${sm.completed})`}
          </li>
          <li>
            Average time to finish a scenario unassisted:{' '}
            {sm.meanUnassistedMs === null ? '—' : formatDuration(sm.meanUnassistedMs)}
          </li>
          <li>
            Chat turns without &ldquo;I&apos;m stuck&rdquo;:{' '}
            {sm.turnsWithoutStuck === null ? '—' : pct(sm.turnsWithoutStuck)}
          </li>
        </ul>
        <JournalProgress refreshKey={0} />
      </section>
    </div>
  );
}
