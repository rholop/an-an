import { DEFAULT_LEARNER_CONFIG } from '@anan/core';
import { currentSession, db as sessionDb, onSessionChange } from '../db/instance.js';
import type { AnanDB } from '../db/schema.js';
import { registerAfterMerge } from './profile-controller.js';
import { markStudyDirty } from './study-dirty.js';

/**
 * Phase 21 Part G: target retention is ONE setting (per profile, synced): the FSRS scheduler
 * schedules with it and the garden wilts against it. CLAUDE.md: 0.85–0.90, default 0.9.
 */
export const RETENTION_KEY = 'targetRetention';
export const RETENTION_MIN = 0.85;
export const RETENTION_MAX = 0.95;
export const DEFAULT_RETENTION = DEFAULT_LEARNER_CONFIG.requestRetention;

export const clampRetention = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, v)) : DEFAULT_RETENTION;

export async function readTargetRetention(db: AnanDB = sessionDb): Promise<number> {
  try {
    const row = await db.settings.get(RETENTION_KEY);
    return clampRetention(row?.value);
  } catch {
    return DEFAULT_RETENTION;
  }
}

/** Load the stored value into the current profile's scheduler. */
export async function applyStoredRetention(): Promise<number> {
  const session = currentSession();
  if (!session) return DEFAULT_RETENTION;
  const r = await readTargetRetention(session.db);
  if (currentSession() === session) session.learnerService.setRequestRetention(r);
  return r;
}

export async function setTargetRetention(v: number): Promise<number> {
  const r = clampRetention(v);
  await sessionDb.settings.put({ key: RETENTION_KEY, value: r });
  currentSession()?.learnerService.setRequestRetention(r);
  markStudyDirty();
  return r;
}

onSessionChange((s) => {
  if (s) void applyStoredRetention();
});
registerAfterMerge(() => void applyStoredRetention());
if (currentSession()) void applyStoredRetention();
