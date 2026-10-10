import { useEffect, useRef, useState } from 'react';
import type { Ledger, StreakConfig, StreakDay } from '@anan/core';
import { gameService } from '../db/instance.js';
import { STREAK_KEEP_GROWING, streakAria, streakLine } from '../lib/labels.js';
import { NextDropIcon, SeedIcon, SproutIcon, TodayIcon } from './PlantIcons.js';
import './StreakBar.css';

/** Asks the app to open a page (and scroll to a section on it). */
export function openPage(route: string, anchor?: string): void {
  window.dispatchEvent(new CustomEvent('anan:go', { detail: { route, anchor } }));
}

function DayIcon({ day, grow }: { day: StreakDay; grow: boolean }) {
  switch (day.status) {
    case 'active':
      return <SproutIcon className={grow ? 'streak-grow' : undefined} />;
    case 'freeze':
      return <NextDropIcon />;
    case 'today':
      return <TodayIcon />;
    default:
      return <SeedIcon />;
  }
}

/**
 * Phase 32: the tiny streak bar on Home. The last seven days as plants (sprout = active, seed =
 * missed, droplet outline = a rest day the run kept, dashed outline = today, still open), the run
 * and the best run, all from the ledger's active days. Tapping opens Progress at the streak.
 */
export function StreakBar({ ledger }: { ledger: Ledger | undefined }) {
  const [config, setConfig] = useState<StreakConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    gameService
      .getStreakConfig()
      .then((c) => !cancelled && setConfig(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const activeToday = ledger?.activeToday() ?? false;
  // The gentle grow plays once, when today's first action lands while Home is open.
  const wasActive = useRef<boolean | undefined>(undefined);
  const [grow, setGrow] = useState(false);
  useEffect(() => {
    if (!ledger) return;
    if (wasActive.current === false && activeToday) setGrow(true);
    wasActive.current = activeToday;
  }, [ledger, activeToday]);

  if (!ledger || !config || !config.enabled) return null;
  const streak = ledger.streak(ledger.activeDays(), config);
  const week = ledger.streakWeek(ledger.activeDays(), config);
  return (
    <button
      type="button"
      className="streak-bar"
      data-testid="streak-bar"
      aria-label={streakAria(streak.current, streak.best, activeToday)}
      onClick={() => openPage('progress', 'streak')}
    >
      <span className="streak-bar-days" aria-hidden="true">
        {week.map((d, i) => (
          <DayIcon key={d.day} day={d} grow={grow && i === week.length - 1} />
        ))}
      </span>
      <span className="streak-bar-text" aria-hidden="true">
        <span data-testid="streak-bar-line">{streakLine(streak.current, streak.best)}</span>
        {!activeToday && <span className="streak-bar-hint"> · {STREAK_KEEP_GROWING}</span>}
      </span>
    </button>
  );
}
