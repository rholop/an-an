import { useSyncExternalStore } from 'react';
import { REVIEW_PILE_CONFIG } from '@anan/core';
import { currentSession, db, onSessionChange } from '../db/instance.js';
import { setBulkCapSource } from './learner-service.js';

/** Phase 20: Settings → Review. Per profile (the `settings` table syncs with the profile). */
export interface ReviewSettings {
  dailyCap: number;
}

const KEY = 'reviewSettings';
const DEFAULTS: ReviewSettings = { dailyCap: REVIEW_PILE_CONFIG.dailyCap };

let settings: ReviewSettings = { ...DEFAULTS };
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function sanitizeReviewSettings(v: unknown): ReviewSettings {
  const o = (v ?? {}) as Partial<ReviewSettings>;
  const cap = typeof o.dailyCap === 'number' && Number.isFinite(o.dailyCap) ? Math.round(o.dailyCap) : DEFAULTS.dailyCap;
  return { dailyCap: Math.min(500, Math.max(10, cap)) };
}

async function load(): Promise<void> {
  if (loaded || !currentSession()) return;
  loaded = true;
  const forProfile = currentSession()!.profileId;
  const row = await db.settings.get(KEY).catch(() => undefined);
  if (currentSession()?.profileId !== forProfile) return;
  if (row?.value) settings = sanitizeReviewSettings(row.value);
  notify();
}

onSessionChange((s) => {
  settings = { ...DEFAULTS };
  loaded = false;
  notify();
  if (s) void load();
});

setBulkCapSource(() => settings.dailyCap);

/** After a sync merge replaced the database contents. */
export function reloadReviewSettings(): void {
  loaded = false;
  void load();
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  await load();
  return settings;
}

export async function updateReviewSettings(patch: Partial<ReviewSettings>): Promise<void> {
  settings = sanitizeReviewSettings({ ...settings, ...patch });
  loaded = true;
  notify();
  await db.settings.put({ key: KEY, value: settings });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useReviewSettings(): ReviewSettings {
  if (!loaded && currentSession()) void load();
  return useSyncExternalStore(subscribe, () => settings);
}
