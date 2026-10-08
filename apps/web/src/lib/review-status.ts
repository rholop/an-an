import { useEffect, useState } from 'react';
import {
  activeEvidence,
  PRIORITY_CONFIG,
  reviewStatus,
  sessionCards,
  sessionForecast,
  statusEvidenceSince,
  type Evidence,
  type ForecastDay,
  type ReviewStatus,
  type SessionWindow,
  type SkillCard,
} from '@anan/core';
import { db } from '../db/instance.js';
import { getReviewSettings, useReviewSettings, type ReviewSettings } from './review-settings.js';
import { onStudyDirty } from './study-dirty.js';

/**
 * Phase 22 Part A: the one place the app loads review numbers. Home, Review, Garden and the nav
 * all show what this returns (core `reviewStatus`), so a count on one screen always matches the
 * others and the session a button opens. Phase 23: the numbers are per review session (morning /
 * evening in the profile's time zone).
 */
export interface LoadedReviewStatus {
  status: ReviewStatus;
  /** Two bars a day (morning, evening) for the next 7 days. */
  forecast: ForecastDay[];
  settings: ReviewSettings;
}

async function sessionEvidence(now: Date, settings: ReviewSettings): Promise<Evidence[]> {
  const since = statusEvidenceSince(now, settings);
  const rows = await db.evidence.where('at').between(since, now, true, true).toArray();
  return activeEvidence(rows);
}

async function allCards(): Promise<SkillCard[]> {
  const rows = await db.items.toArray();
  return rows.map(({ pk: _pk, ...c }) => c as SkillCard);
}

export async function loadReviewStatus(
  now: Date = new Date(),
  settings?: ReviewSettings,
): Promise<LoadedReviewStatus> {
  const s = settings ?? (await getReviewSettings());
  const [cards, evidence] = await Promise.all([allCards(), sessionEvidence(now, s)]);
  return {
    status: reviewStatus({ cards, evidence, now, settings: s, baseNew: PRIORITY_CONFIG.reviewNewItems }),
    forecast: sessionForecast({ cards, evidence, now, settings: s, days: 7 }),
    settings: s,
  };
}

/** This session's cards (or with `early`, between sessions, the next session's), and the status. */
export async function loadSessionCards(
  now: Date = new Date(),
  opts: { early?: boolean } = {},
): Promise<{ cards: SkillCard[]; window?: SessionWindow } & LoadedReviewStatus> {
  const s = await getReviewSettings();
  const [cards, evidence] = await Promise.all([allCards(), sessionEvidence(now, s)]);
  const picked = sessionCards({ cards, evidence, now, settings: s, ...(opts.early ? { early: true } : {}) });
  return {
    ...picked,
    status: reviewStatus({ cards, evidence, now, settings: s, baseNew: PRIORITY_CONFIG.reviewNewItems }),
    forecast: sessionForecast({ cards, evidence, now, settings: s, days: 7 }),
    settings: s,
  };
}

/** Live review status: refreshes after any study change, a settings change (session times, time
 * zone, cap), and when a session opens or ends. */
export function useReviewStatus(): LoadedReviewStatus | null {
  const [value, setValue] = useState<LoadedReviewStatus | null>(null);
  const [tick, setTick] = useState(0);
  const settings = useReviewSettings();
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let cancelled = false;
    loadReviewStatus(new Date(), settings)
      .then((v) => !cancelled && setValue(v))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tick, settings]);
  const boundary = value
    ? Math.min(value.status.sessionEndsAt?.getTime() ?? Infinity, value.status.nextSession.opensAt.getTime())
    : undefined;
  useEffect(() => {
    if (boundary === undefined || !Number.isFinite(boundary)) return;
    // setTimeout's limit is ~24.8 days; the next session boundary is always within a day.
    const id = setTimeout(() => setTick((t) => t + 1), Math.max(1000, boundary - Date.now() + 500));
    return () => clearTimeout(id);
  }, [boundary]);
  return value;
}
