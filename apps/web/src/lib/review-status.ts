import { useEffect, useState } from 'react';
import {
  activeEvidence,
  PRIORITY_CONFIG,
  reviewForecast,
  reviewStatus,
  type Evidence,
  type ReviewStatus,
  type SkillCard,
} from '@anan/core';
import { db } from '../db/instance.js';
import { getReviewSettings, useReviewSettings } from './review-settings.js';
import { onStudyDirty } from './study-dirty.js';

/**
 * Phase 22 Part A: the one place the app loads review numbers. Home, Review, Garden and the nav
 * all show what this returns (core `reviewStatus`), so a count on one screen always matches the
 * others and the session a button opens.
 */
export interface LoadedReviewStatus {
  status: ReviewStatus;
  /** [rest of today, tomorrow, …] (cards due now are `status.dueNow`, not a bar). */
  forecast: number[];
}

async function todaysEvidence(now: Date): Promise<Evidence[]> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const rows = await db.evidence.where('at').between(start, now, true, true).toArray();
  return activeEvidence(rows);
}

export async function loadReviewStatus(
  now: Date = new Date(),
  cap?: number,
): Promise<LoadedReviewStatus> {
  const [rows, evidence, rs] = await Promise.all([
    db.items.toArray(),
    todaysEvidence(now),
    cap === undefined ? getReviewSettings() : Promise.resolve({ dailyCap: cap }),
  ]);
  const cards = rows.map(({ pk: _pk, ...c }) => c as SkillCard);
  return {
    status: reviewStatus({
      cards,
      evidence,
      now,
      cap: rs.dailyCap,
      baseNew: PRIORITY_CONFIG.reviewNewItems,
    }),
    forecast: reviewForecast(cards, now, 7),
  };
}

/** Live review status: refreshes after any study change, a cap change, and when the next
 * later-today card falls due (so "3 more later today" turns into "3 due now" on its own). */
export function useReviewStatus(): LoadedReviewStatus | null {
  const [value, setValue] = useState<LoadedReviewStatus | null>(null);
  const [tick, setTick] = useState(0);
  const { dailyCap } = useReviewSettings();
  useEffect(() => onStudyDirty(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let cancelled = false;
    loadReviewStatus(new Date(), dailyCap)
      .then((v) => !cancelled && setValue(v))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tick, dailyCap]);
  const next = value?.status.nextDueAt?.getTime();
  useEffect(() => {
    if (next === undefined) return;
    // setTimeout's limit is ~24.8 days; "later today" is always well under it.
    const id = setTimeout(() => setTick((t) => t + 1), Math.max(1000, next - Date.now() + 500));
    return () => clearTimeout(id);
  }, [next]);
  return value;
}
